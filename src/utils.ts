import pathModule from "path"
import os from "os"
import fs from "fs-extra"
import axios from "axios"
import { v4 as uuidv4 } from "uuid"
import crypto from "crypto"
import { exec } from "child_process"
import sudoPrompt from "sudo-prompt"
import net from "net"
import https from "https"
import diskusage from "diskusage-ng"

export const httpsAgent = new https.Agent({
	rejectUnauthorized: false
})

/**
 * Return the platforms config path.
 *
 * @export
 * @returns {Promise<string>}
 */
export async function platformConfigPath(): Promise<string> {
	// Ref: https://github.com/FilenCloudDienste/filen-cli/blob/main/src/util.ts

	let configPath = ""

	switch (process.platform) {
		case "win32":
			configPath = pathModule.resolve(process.env.APPDATA!)
			break

		case "darwin":
			configPath = pathModule.resolve(pathModule.join(os.homedir(), "Library/Application Support/"))
			break

		default:
			configPath = process.env.XDG_CONFIG_HOME
				? pathModule.resolve(process.env.XDG_CONFIG_HOME)
				: pathModule.resolve(pathModule.join(os.homedir(), ".config/"))
			break
	}

	if (!configPath || configPath.length === 0) {
		throw new Error("Could not find homedir path.")
	}

	configPath = pathModule.join(configPath, "@filen", "network-drive")

	if (!(await fs.exists(configPath))) {
		await fs.mkdir(configPath, {
			recursive: true
		})
	}

	return configPath
}

export async function downloadBinaryAndVerifySHA512(url: string, destination: string, neededHash: string): Promise<void> {
	const tmpPath = pathModule.join(pathModule.dirname(destination), `${uuidv4()}.tmp`)

	await fs.ensureDir(pathModule.dirname(tmpPath))

	const writer = fs.createWriteStream(tmpPath)
	const response = await axios({
		method: "get",
		url: url,
		responseType: "stream"
	})

	response.data.pipe(writer)

	await new Promise<void>((resolve, reject) => {
		writer.on("finish", resolve)
		writer.on("error", reject)
	})

	const hash = await new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash("sha512")
		const stream = fs.createReadStream(tmpPath)

		stream.on("data", data => hash.update(data))
		stream.on("end", () => resolve(hash.digest("hex")))
		stream.on("error", reject)
	})

	if (hash !== neededHash) {
		throw new Error(`Hash verification failed for ${url}. Expected: ${neededHash}, computed: ${hash}.`)
	}

	await fs.move(tmpPath, destination, {
		overwrite: true
	})
}

export async function execCommand(command: string, trimStdOut: boolean = true): Promise<string> {
	return new Promise((resolve, reject) => {
		exec(
			command,
			{
				shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh"
			},
			(err, stdout, stderr) => {
				if (err || stderr) {
					reject(err ? err : new Error(stderr))

					return
				}

				resolve(trimStdOut ? stdout.trim() : stdout)
			}
		)
	})
}

export async function execCommandSudo(command: string, trimStdOut: boolean = true): Promise<string> {
	return new Promise((resolve, reject) => {
		sudoPrompt.exec(command, { name: "Filen" }, (err, stdout, stderr) => {
			if (err || stderr) {
				if (!stderr) {
					stdout = ""
				}

				if (stderr instanceof Buffer) {
					stderr = stderr.toString("utf-8")
				}

				reject(err ? err : new Error(stderr))

				return
			}

			if (!stdout) {
				stdout = ""
			}

			if (stdout instanceof Buffer) {
				stdout = stdout.toString("utf-8")
			}

			resolve(trimStdOut ? stdout.trim() : stdout)
		})
	})
}

export async function killProcessByName(processName: string): Promise<void> {
	if (os.platform() === "win32") {
		await execCommand(`taskkill /F /T /IM ${processName}`)
	} else {
		const stdout = await execCommand(`pgrep -f ${processName}`)
		const pids = stdout.split("\n").filter(pid => pid && pid.trim().length > 0)

		for (const pid of pids) {
			await execCommand(`kill -9 ${pid.trim()}`)
		}
	}
}

export async function killProcessByPid(pid: number): Promise<void> {
	await execCommand(os.platform() === "win32" ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`)
}

export async function isWinFSPInstalled(): Promise<boolean> {
	if (process.platform !== "win32") {
		return false
	}

	const possiblePaths = [
		"C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll",
		"C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll",
		pathModule.join(process.env.ProgramFiles || "", "WinFsp", "bin", "winfsp-x64.dll"),
		pathModule.join(process.env["ProgramFiles(x86)"] || "", "WinFsp", "bin", "winfsp-x64.dll")
	]

	for (const dllPath of possiblePaths) {
		try {
			await fs.access(dllPath, fs.constants.F_OK)

			return true
		} catch {
			// Noop
		}
	}

	return false
}

export async function isFUSE3InstalledOnLinux(): Promise<boolean> {
	if (process.platform !== "linux") {
		return false
	}

	try {
		// First check if fuse3 binary is installed using `which`
		const fuse3Check = await execCommand("which fuse3")

		if (fuse3Check.trim().length > 0 && fuse3Check.includes("/")) {
			return true
		}

		// DPKG check
		const dpkg = await execCommand(
			// eslint-disable-next-line quotes
			'dpkg -l | grep -E "^ii\\s+fuse3\\s|^ii\\s+libfuse3\\s"'
		)

		if (dpkg.includes("fuse3")) {
			return true
		}

		// Fallback: Check using `pkg-config` if fuse3 libraries are installed
		const pkgConfigCheck = await execCommand("pkg-config --exists fuse3 || echo $?")

		if (pkgConfigCheck.trim() === "0") {
			return true
		}

		// Fallback: Check if `yum` or `apk` package manager contains fuse3 package
		const yumCheck = await execCommand("yum list installed fuse3 || echo $?")

		if (!yumCheck.toLowerCase().includes("no matching packages")) {
			return true
		}

		const apkCheck = await execCommand("apk info fuse3 || echo $?")

		if (!apkCheck.toLowerCase().includes("fuse3 not found")) {
			return true
		}

		// If all methods fail, return false
		return false
	} catch (error) {
		return false
	}
}

export async function getExistingDrives(): Promise<string[]> {
	const drives: string[] = []

	const driveChecks = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async letter => {
		const drivePath = `${letter}:\\`

		try {
			await fs.access(drivePath)

			drives.push(letter)
		} catch {
			// Noop
		}
	})

	await Promise.all(driveChecks)

	return drives
}

export async function getAvailableDriveLetters(): Promise<string[]> {
	const driveLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
	const existingDrives = await getExistingDrives()
	const availableDrives = driveLetters.filter(letter => !existingDrives.includes(letter)).map(letter => `${letter}:`)

	return availableDrives
}

export async function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()

		server.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				resolve(true)

				return
			}

			reject(err)
		})

		server.once("listening", () => {
			server.close(() => {
				resolve(false)
			})
		})

		server.listen(port)
	})
}

export async function isUnixMountPointValid(mountPoint: string): Promise<boolean> {
	try {
		if (!(await fs.exists(mountPoint))) {
			return false
		}

		await fs.access(mountPoint, fs.constants.R_OK | fs.constants.W_OK)

		const stat = await fs.stat(mountPoint)

		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			!stat.isBlockDevice() &&
			!stat.isCharacterDevice() &&
			!stat.isFIFO() &&
			!stat.isSocket()
		)
	} catch {
		return false
	}
}

export async function checkIfMountExists(mountPoint: string): Promise<boolean> {
	try {
		await fs.access(os.platform() === "win32" ? `${mountPoint}\\\\` : mountPoint, fs.constants.R_OK | fs.constants.W_OK)

		return true
	} catch {
		return false
	}
}

export async function isUnixMountPointEmpty(mountPoint: string): Promise<boolean> {
	try {
		if (!(await fs.exists(mountPoint))) {
			return false
		}

		await fs.access(mountPoint, fs.constants.R_OK | fs.constants.W_OK)

		const dir = await fs.readdir(mountPoint, {
			recursive: true,
			encoding: "utf-8"
		})

		return dir.length === 0
	} catch {
		return false
	}
}

export function generateRandomString(length: number): string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

	const randomBytes = crypto.randomBytes(length + 2)
	const result = new Array(length)
	let cursor = 0

	for (let i = 0; i < length; i++) {
		cursor += randomBytes[i]!
		result[i] = chars[cursor % chars.length]
	}

	return result.join("")
}

export async function httpHealthCheck({
	url,
	method = "GET",
	expectedStatusCode = 200,
	timeout = 5000
}: {
	url: string
	expectedStatusCode?: number
	method?: "GET" | "POST" | "HEAD"
	timeout?: number
}): Promise<boolean> {
	const abortController = new AbortController()

	const timeouter = setTimeout(() => {
		abortController.abort()
	}, timeout)

	try {
		const response = await axios({
			url,
			timeout,
			method,
			signal: abortController.signal,
			validateStatus: () => true,
			httpsAgent
		})

		clearTimeout(timeouter)

		return response.status === expectedStatusCode
	} catch (e) {
		clearTimeout(timeouter)

		return false
	}
}

export function normalizePathForCmd(path: string): string {
	if (process.platform === "win32") {
		return path
	}

	return pathModule.normalize(path).replace(/(\s+)/g, "\\$1")
}

export async function getAvailableCacheSize(cachePath: string): Promise<number> {
	await fs.ensureDir(cachePath)

	return await new Promise<number>((resolve, reject) => {
		diskusage(cachePath, (err, usage) => {
			if (err) {
				reject(err)

				return
			}

			resolve(usage.available)
		})
	})
}

export async function isProcessRunning(processName: string): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		let command = ""

		if (process.platform === "win32") {
			command = `tasklist /FI "IMAGENAME eq ${processName}"`
		} else if (process.platform === "darwin" || process.platform === "linux") {
			command = `pgrep -f ${processName}`
		} else {
			reject(false)

			return
		}

		exec(command, (err, stdout, stderr) => {
			if (err) {
				reject(false)

				return
			}

			if (stderr) {
				reject(false)

				return
			}

			resolve(stdout.trim().length > 0)
		})
	})
}

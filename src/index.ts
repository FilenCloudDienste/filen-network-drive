import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import { Semaphore, type ISemaphore } from "./semaphore"
import WebDAVServer from "@filen/webdav"
import { spawn, type ChildProcess } from "child_process"
import {
	platformConfigPath,
	downloadBinaryAndVerifySHA256,
	checkIfMountExists,
	isProcessRunning,
	execCommandSudo,
	killProcessByPid,
	killProcessByName,
	isFUSEInstalledOnLinux,
	isWinFSPInstalled,
	getAvailableCacheSize,
	getAvailableDriveLetters,
	execCommand,
	isUnixMountPointValid,
	isUnixMountPointEmpty,
	generateRandomString,
	httpHealthCheck,
	normalizePathForCmd
} from "./utils"
import pathModule from "path"
import fs from "fs-extra"
import findFreePorts from "find-free-ports"
import writeFileAtomic from "write-file-atomic"

export const RCLONE_VERSION = "1670"
export const rcloneBinaryName = `filen_rclone_${process.platform}_${process.arch}_${RCLONE_VERSION}${
	process.platform === "win32" ? ".exe" : ""
}`
export const RCLONE_URL = `https://cdn.filen.io/@filen/desktop/bin/rclone/${rcloneBinaryName}`
export const RCLONE_HASHES: Record<string, string> = {
	filen_rclone_darwin_arm64_1670: "259030c7c785b65d4a8d17529ded1b335e0cd5932c76cabdec38675f19745385",
	filen_rclone_darwin_x64_1670: "17fdc70237cbc52af7c69516ef5a594b68867b274308e1dc569d82fe5120ca51",
	filen_rclone_linux_arm64_1670: "f41d3d3b5f623c8a21cb67f1fbb4ec7e477bc7a5cb2b56529917a72bc5090171",
	filen_rclone_linux_ia32_1670: "f2cc417cf17f872e6cba1caf8ebf4a0490e3977da09ff81f0d76896114fd0ffd",
	filen_rclone_linux_x64_1670: "315f9b2fa2c1e1bdf9f89ec3e59293a84ae2d339d91625587e26cd09dac8a447",
	"filen_rclone_win32_arm64_1670.exe": "346933fb277ba6b1efa0ef6e406d0abfe2db5a6209dad8be4f083b40a14d6ae1",
	"filen_rclone_win32_ia32_1670.exe": "91eb96d6dca1af6a2db2b08159c9354ee85e4226bd217412eb2ed3d03af53329",
	"filen_rclone_win32_x64_1670.exe": "c189595c36996bdb7dce6ec28cf6906a00cbb5c5fe182e038bf476d74bed349e"
}

/**
 * Description placeholder
 *
 * @export
 * @class VirtualDrive
 * @typedef {VirtualDrive}
 */
export class VirtualDrive {
	private readonly sdk: FilenSDK
	private webdavServer: WebDAVServer | null = null
	private rcloneProcess: ChildProcess | null = null
	private webdavUsername: string = "admin"
	private webdavPassword: string = "admin"
	private webdavPort: number = 1905
	private webdavEndpoint: string = "http://127.0.0.1:1905"
	private active: boolean = false
	private rcloneBinaryPath: string | null = null
	private rcloneConfigPath: string | null = null
	private configPath: string | null = null
	private readonly startMutex: ISemaphore = new Semaphore(1)
	private readonly stopMutex: ISemaphore = new Semaphore(1)
	private readonly getRCloneBinaryMutex: ISemaphore = new Semaphore(1)
	private cachePath: string | undefined
	private readonly mountPoint: string
	private readonly cacheSize: number
	private readonly logFilePath: string | undefined
	private readonly readOnly: boolean

	public constructor({
		sdk,
		sdkConfig,
		cachePath,
		mountPoint,
		cacheSize,
		logFilePath,
		readOnly
	}: {
		sdk?: FilenSDK
		sdkConfig: FilenSDKConfig
		cachePath?: string
		mountPoint: string
		cacheSize?: number
		logFilePath?: string
		readOnly?: boolean
	}) {
		if (!sdk && !sdkConfig) {
			throw new Error("Either pass a configured SDK instance OR a SDKConfig object to the constructor.")
		}

		this.sdk = sdk
			? sdk
			: new FilenSDK({
					...sdkConfig,
					connectToSocket: true,
					metadataCache: true
			  })
		this.cachePath = cachePath
		this.mountPoint = mountPoint
		this.cacheSize = cacheSize ? cacheSize : 10
		this.logFilePath = logFilePath
		this.readOnly = typeof readOnly === "boolean" ? readOnly : false

		// Start downloading the binary in the background
		this.getRCloneBinaryPath().catch(() => {})
		// Start montioring the mount in the background
		this.monitor().catch(() => {})
	}

	/**
	 * Monitor the virtual drive in the background.
	 * If the underlying WebDAV server or the drive itself becomes unavailable, cleanup.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async monitor(): Promise<void> {
		try {
			if (!this.active) {
				return
			}

			if (!(await this.isMountActuallyActive())) {
				await this.stop()
			}
		} finally {
			await new Promise<void>(resolve => setTimeout(resolve, 15000))

			this.monitor()
		}
	}

	/**
	 * Get the platform config path.
	 *
	 * @private
	 * @async
	 * @returns {Promise<string>}
	 */
	private async getConfigPath(): Promise<string> {
		if (!this.configPath) {
			this.configPath = await platformConfigPath()
		}

		return this.configPath
	}

	/**
	 * Get the VFS cache path.
	 *
	 * @private
	 * @async
	 * @returns {Promise<string>}
	 */
	private async getCachePath(): Promise<string> {
		if (!this.cachePath) {
			this.cachePath = pathModule.join(await this.getConfigPath(), "cache")
		}

		return this.cachePath
	}

	/**
	 * Get the RClone config path.
	 *
	 * @private
	 * @async
	 * @returns {Promise<string>}
	 */
	private async getRCloneConfigPath(): Promise<string> {
		if (!this.rcloneConfigPath) {
			this.rcloneConfigPath = pathModule.join(await this.getConfigPath(), "rclone.conf")
		}

		return this.rcloneConfigPath
	}

	/**
	 * Get the RClone binary path.
	 * Downloads the binary from our CDN if it does not exist.
	 *
	 * @private
	 * @async
	 * @returns {Promise<string>}
	 */
	private async getRCloneBinaryPath(): Promise<string> {
		if (!this.rcloneBinaryPath) {
			await this.getRCloneBinaryMutex.acquire()

			try {
				const configPath = await this.getConfigPath()
				const binaryPath = pathModule.join(configPath, rcloneBinaryName)

				if (!(await fs.exists(binaryPath))) {
					if (!RCLONE_HASHES[rcloneBinaryName]) {
						throw new Error(`Hash for binary name ${rcloneBinaryName} not found in hardcoded record.`)
					}

					await downloadBinaryAndVerifySHA256(RCLONE_URL, binaryPath, RCLONE_HASHES[rcloneBinaryName]!)
				}

				this.rcloneBinaryPath = binaryPath
			} finally {
				this.getRCloneBinaryMutex.release()
			}
		}

		return this.rcloneBinaryPath
	}

	/**
	 * Check if the underyling WebDAV server is online.
	 *
	 * @private
	 * @async
	 * @returns {Promise<boolean>}
	 */
	private async isWebDAVOnline(): Promise<boolean> {
		return await httpHealthCheck({
			url: `http://127.0.0.1:${this.webdavPort}`,
			method: "GET",
			expectedStatusCode: 401
		})
	}

	/**
	 * Check if the mount and the underyling WebDAV server is actually online and accessible.
	 *
	 * @private
	 * @async
	 * @returns {Promise<boolean>}
	 */
	private async isMountActuallyActive(): Promise<boolean> {
		try {
			const [mountExists, webdavOnline, rcloneRunning] = await Promise.all([
				checkIfMountExists(this.mountPoint),
				this.isWebDAVOnline(),
				isProcessRunning(rcloneBinaryName)
			])

			if (!mountExists || !webdavOnline || !rcloneRunning) {
				return false
			}

			const stat = await fs.stat(this.mountPoint)

			return process.platform === "darwin" || process.platform === "linux" ? stat.ino === 0 || stat.birthtimeMs === 0 : stat.ino === 1
		} catch {
			return false
		}
	}

	/**
	 * Obscure the random WebDAV passwort to the RClone format.
	 *
	 * @private
	 * @async
	 * @param {string} password
	 * @returns {Promise<string>}
	 */
	private async obscureRClonePassword(password: string): Promise<string> {
		const binaryPath = await this.getRCloneBinaryPath()

		return await execCommand(`${normalizePathForCmd(binaryPath)} obscure ${password}`)
	}

	/**
	 * Write the RClone config locally.
	 *
	 * @private
	 * @async
	 * @param {string} endpoint
	 * @param {string} user
	 * @param {string} password
	 * @returns {Promise<void>}
	 */
	private async writeRCloneConfig(endpoint: string, user: string, password: string): Promise<void> {
		const [obscuredPassword, configPath] = await Promise.all([this.obscureRClonePassword(password), this.getRCloneConfigPath()])
		const content = `[Filen]\ntype = webdav\nurl = ${endpoint}\nvendor = other\nuser = ${user}\npass = ${obscuredPassword}`

		await writeFileAtomic(configPath, content, "utf-8")
	}

	/**
	 * Generate the "rclone (nfs)mount" arguments.
	 *
	 * @private
	 * @async
	 * @param {{ cachePath: string; configPath: string }} param0
	 * @param {string} param0.cachePath
	 * @param {string} param0.configPath
	 * @returns {Promise<string[]>}
	 */
	private async rcloneArgs({ cachePath, configPath }: { cachePath: string; configPath: string }): Promise<string[]> {
		const availableCacheSize = await getAvailableCacheSize(cachePath)

		const excludePatterns = [
			// macOS temporary files and folders
			".DS_Store",
			"._*",
			".Trashes/**",
			".Spotlight-V100/**",
			".TemporaryItems/**",
			// Windows temporary files and folders
			"*.tmp",
			"~*",
			"Thumbs.db",
			"desktop.ini",
			"$RECYCLE.BIN/**",
			"System Volume Information/**",
			"Temp/**",
			"AppData/Local/Temp/**",
			// Linux temporary files and folders
			".Trash*",
			"*.swp",
			"*.temp",
			".*.swx",
			"/tmp/**",
			"/var/tmp/**",
			// Other common exclusions
			"**/.cache/**",
			"**/Cache/**",
			"**/.npm/_cacache/**"
		]

		const availableCacheSizeGib = Math.floor(availableCacheSize / (1024 / 1024 / 1024))
		const cacheSize = this.cacheSize >= availableCacheSizeGib ? availableCacheSizeGib : this.cacheSize

		return [
			`${process.platform === "win32" || process.platform === "linux" ? "mount" : "nfsmount"} Filen: ${normalizePathForCmd(
				this.mountPoint
			)}`,
			`--config "${configPath}"`,
			"--vfs-cache-mode full",
			...(this.readOnly ? ["--read-only"] : []),
			`--cache-dir "${cachePath}"`,
			`--vfs-cache-max-size ${cacheSize}Gi`,
			"--vfs-cache-min-free-space 5Gi",
			"--vfs-cache-max-age 720h",
			"--vfs-cache-poll-interval 1m",
			"--dir-cache-time 1m",
			"--cache-info-age 1m",
			// Already present in the SDK fs() class
			//"--vfs-block-norm-dupes",
			"--noappledouble",
			"--noapplexattr",
			"--no-gzip-encoding",
			"--low-level-retries 10",
			"--retries 10",
			"--use-mmap",
			"--disable-http2",
			"--file-perms 0666",
			"--dir-perms 0777",
			"--use-server-modtime",
			"--vfs-read-chunk-size 128Mi",
			"--buffer-size 0",
			"--vfs-read-ahead 1024Mi",
			"--vfs-read-chunk-size-limit 0",
			"--no-checksum",
			"--transfers 16",
			"--vfs-fast-fingerprint",
			...(this.logFilePath ? [`--log-file "${this.logFilePath}"`] : []),
			"--devname Filen",
			...(process.platform === "win32" ? ["--volname \\\\Filen\\Filen"] : ["--volname Filen"]),
			...(process.platform === "win32"
				? // eslint-disable-next-line quotes
				  ['-o FileSecurity="D:P(A;;FA;;;WD)"', "--network-mode"]
				: []),
			...excludePatterns.map(pattern => `--exclude "${pattern}"`)
		]
	}

	/**
	 * Spawn the RClone process.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async spawnRClone(): Promise<void> {
		const [binaryPath, configPath, cachePath] = await Promise.all([
			this.getRCloneBinaryPath(),
			this.getRCloneConfigPath(),
			this.getCachePath()
		])

		if (!(await fs.exists(binaryPath))) {
			throw new Error(`Virtual drive binary not found at ${binaryPath}.`)
		}

		if (!(await fs.exists(configPath))) {
			throw new Error(`Virtual drive config not found at ${configPath}.`)
		}

		await fs.ensureDir(cachePath)

		if (this.logFilePath) {
			if (await fs.exists(this.logFilePath)) {
				const logStats = await fs.stat(this.logFilePath)

				if (logStats.size > 1024 * 1024 * 10) {
					await fs.unlink(this.logFilePath)
				}
			}
		}

		const args = await this.rcloneArgs({
			cachePath,
			configPath
		})

		return new Promise<void>((resolve, reject) => {
			let checkInterval: NodeJS.Timeout | undefined = undefined
			let checkTimeout: NodeJS.Timeout | undefined = undefined
			let rcloneSpawned = false

			checkInterval = setInterval(async () => {
				try {
					if ((await this.isMountActuallyActive()) && rcloneSpawned) {
						clearInterval(checkInterval)
						clearTimeout(checkTimeout)

						resolve()
					}
				} catch {
					// Noop
				}
			}, 1000)

			checkTimeout = setTimeout(async () => {
				try {
					if (!(await this.isMountActuallyActive())) {
						clearInterval(checkInterval)
						clearTimeout(checkTimeout)

						reject(new Error("Could not start virtual drive."))
					}
				} catch (e) {
					clearInterval(checkInterval)
					clearTimeout(checkTimeout)

					reject(e)
				}
			}, 30000)

			this.rcloneProcess = spawn(normalizePathForCmd(binaryPath), args, {
				stdio: "ignore",
				shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
				detached: false
			})

			this.rcloneProcess.on("spawn", () => {
				rcloneSpawned = true
			})

			this.rcloneProcess.on("error", err => {
				rcloneSpawned = false

				clearInterval(checkInterval)
				clearTimeout(checkTimeout)

				reject(err)
			})

			this.rcloneProcess.on("exit", () => {
				rcloneSpawned = false

				clearInterval(checkInterval)
				clearTimeout(checkTimeout)

				reject(new Error("Could not start virtual drive."))
			})
		})
	}

	/**
	 * Cleanup the RClone process.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async cleanupRClone(): Promise<void> {
		if (this.rcloneProcess) {
			this.rcloneProcess.removeAllListeners()

			if (this.rcloneProcess.stdin) {
				try {
					this.rcloneProcess.stdin.removeAllListeners()
					this.rcloneProcess.stdin.destroy()
				} catch {
					// Noop
				}
			}

			if (this.rcloneProcess.stdout) {
				try {
					this.rcloneProcess.stdout.removeAllListeners()
					this.rcloneProcess.stdout.destroy()
				} catch {
					// Noop
				}
			}

			if (this.rcloneProcess.stderr) {
				try {
					this.rcloneProcess.stderr.removeAllListeners()
					this.rcloneProcess.stderr.destroy()
				} catch {
					// Noop
				}
			}

			this.rcloneProcess.kill("SIGKILL")

			if (this.rcloneProcess.pid) {
				await killProcessByPid(this.rcloneProcess.pid).catch(() => {})
			}
		}

		await killProcessByName(rcloneBinaryName).catch(() => {})

		if (process.platform === "linux" || process.platform === "darwin") {
			const umountCmd =
				process.platform === "darwin"
					? `umount -f ${normalizePathForCmd(this.mountPoint)}`
					: `umount -f -l ${normalizePathForCmd(this.mountPoint)}`
			const listCmd = `mount -t ${process.platform === "linux" ? "fuse.rclone" : "nfs"}`
			let listedMounts = await execCommand(listCmd)

			if (listedMounts.length > 0 && listedMounts.includes(normalizePathForCmd(this.mountPoint))) {
				await execCommand(umountCmd).catch(() => {})
			}

			await new Promise<void>(resolve => setTimeout(resolve, 500))

			listedMounts = await execCommand(listCmd)

			if (listedMounts.length > 0 && listedMounts.includes(normalizePathForCmd(this.mountPoint))) {
				await execCommandSudo(umountCmd).catch(() => {})
			}
		}
	}

	/**
	 * Start the virtual drive.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async start(): Promise<void> {
		await this.startMutex.acquire()

		try {
			await this.stop()

			if (process.platform === "win32" && !(await isWinFSPInstalled())) {
				throw new Error("WinFSP not installed.")
			}

			if (process.platform === "linux" && !(await isFUSEInstalledOnLinux())) {
				throw new Error("FUSE not installed.")
			}

			if (process.platform === "win32") {
				const availableDriveLetters = await getAvailableDriveLetters()

				if (!availableDriveLetters.includes(this.mountPoint)) {
					throw new Error(`Cannot mount virtual drive at ${this.mountPoint}: Drive letter exists.`)
				}
			} else {
				if (process.platform === "linux" && !this.mountPoint.startsWith(`/home/${process.env.USER ?? "user"}`)) {
					throw new Error("Cannot mount to a directory outside of your home directory.")
				}

				if (process.platform === "darwin" && !this.mountPoint.startsWith(`/Users/${process.env.USER ?? "user"}`)) {
					throw new Error("Cannot mount to a directory outside of your user directory.")
				}

				if (!(await isUnixMountPointValid(this.mountPoint))) {
					throw new Error(`Cannot mount virtual drive at ${this.mountPoint}: Mount point does not exist.`)
				}

				if (!(await isUnixMountPointEmpty(this.mountPoint))) {
					throw new Error(`Cannot mount virtual drive at ${this.mountPoint}: Mount point not empty.`)
				}
			}

			const [port] = await findFreePorts(1)

			if (!port) {
				throw new Error("Could not find a free port.")
			}

			this.webdavPort = port
			this.webdavUsername = generateRandomString(32)
			this.webdavPassword = generateRandomString(32)
			this.webdavEndpoint = `http://127.0.0.1:${this.webdavPort}`
			this.webdavServer = new WebDAVServer({
				hostname: "127.0.0.1",
				port: this.webdavPort,
				https: false,
				user: {
					username: this.webdavUsername,
					password: this.webdavPassword,
					sdk: this.sdk
				},
				authMode: "basic"
			})

			await this.webdavServer.start()
			await this.writeRCloneConfig(this.webdavEndpoint, this.webdavUsername, this.webdavPassword)
			await this.spawnRClone()

			if (!(await this.isMountActuallyActive())) {
				throw new Error("Could not start virtual drive.")
			}

			this.active = true
		} finally {
			this.startMutex.release()
		}
	}

	/**
	 * Stop the virtual drive.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async stop(): Promise<void> {
		await this.stopMutex.acquire()

		try {
			if (!this.active) {
				return
			}

			const webdavOnline = await this.isWebDAVOnline()

			if (webdavOnline && this.webdavServer?.serverInstance) {
				await this.webdavServer?.stop()
			}

			await this.cleanupRClone()

			this.webdavServer = null
			this.rcloneProcess = null
			this.active = false
		} finally {
			this.stopMutex.release()
		}
	}
}

export default VirtualDrive

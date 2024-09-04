import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import { Semaphore, type ISemaphore } from "./semaphore"
import WebDAVServer from "@filen/webdav"
import { spawn, type ChildProcess } from "child_process"
import {
	platformConfigPath,
	downloadBinaryAndVerifySHA512,
	checkIfMountExists,
	isProcessRunning,
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
import axios from "axios"
import { type RCCoreStats, type RCVFSStats, type GetStats } from "./types"
import { writeMonitorScriptAndReturnPath } from "./monitor"

export const RCLONE_VERSION = "1670"
export const rcloneBinaryName = `filen_rclone_${process.platform}_${process.arch}_${RCLONE_VERSION}${
	process.platform === "win32" ? ".exe" : ""
}`
export const RCLONE_URL = `https://cdn.filen.io/@filen/desktop/bin/rclone/${rcloneBinaryName}`
export const RCLONE_HASHES: Record<string, string> = {
	filen_rclone_darwin_arm64_1670:
		"19e2c49e08eb2a5333f4683b5b9f92c49d1f7a88c3a61bfbd1c7d52486e07f92b10e0162761775d247d9be30ecd7e2896d9b25bb03bbc4c3e1ebe217a48aa5ae",
	filen_rclone_darwin_x64_1670:
		"2175f6eb7bdc22df74dfd850b49efe683b8a2f3d4550c0d3e1d71bfc2c1462dae872f3957e053eb623097f73945d59e8efcfff550902d002be7010679f401ff2",
	filen_rclone_linux_arm64_1670:
		"6b5935894d82c3b6468976de539e3996e096cb67c30a13714301e4d5d55f0f02e7a9ef4a3b4c13f2deae0086b2f39af615820cafbe218dd438d49f8e071893e7",
	filen_rclone_linux_ia32_1670:
		"431e0113206957886d839f87e6d7654abfd6c32ea0289e4ffd3d293a9f054301429501e908af097bd27da635422625432fa94360e82b6fe7d5ce9d619242f3ac",
	filen_rclone_linux_x64_1670:
		"027c850ac1bbb7b6f13c059544de8aacd985067d7595d87a202dbf583d47b88a65778506c4373288235335161d997dcafea04ccf8a34c3c398536ab174427a24",
	"filen_rclone_win32_arm64_1670.exe":
		"0e97010c819e51d90e918009ef45ae6daa7e666620ede85221c2e5e0f5b0a5a7050ba0ac986001e936627ef95249c0c7847b3b931e2d053b3ced39440ef3f713",
	"filen_rclone_win32_ia32_1670.exe":
		"f3a667d0bb000aaa044e70f84ea8afb8da5027ad0c996ef2110d1cd9c15f589874c281c1bd3a4e90c1384688d98abb9179c5218b6d3a301d22e50e85341f3770",
	"filen_rclone_win32_x64_1670.exe":
		"de73b2f22b30ea216e1eb62c05ac5da85796c7d0ee556cc7b04c077a5a80f2ae8a86416ac051c2126dc5ff7cc85482841973ee887002341e82c2587429f95166"
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
	private monitorProcess: ChildProcess | null = null
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
	private rclonePort: number = 1906
	private monitorScriptPath: string | null = null

	/**
	 * Creates an instance of VirtualDrive.
	 *
	 * @constructor
	 * @public
	 * @param {{
	 * 		sdk?: FilenSDK
	 * 		sdkConfig: FilenSDKConfig
	 * 		cachePath?: string
	 * 		mountPoint: string
	 * 		cacheSize?: number
	 * 		logFilePath?: string
	 * 		readOnly?: boolean
	 * 	}} param0
	 * @param {FilenSDK} param0.sdk
	 * @param {FilenSDKConfig} param0.sdkConfig
	 * @param {string} param0.cachePath
	 * @param {string} param0.mountPoint "X:" uppercase drive letter following : on windows, /path/to/mount of linux/macos
	 * @param {number} param0.cacheSize in Gibibytes
	 * @param {string} param0.logFilePath
	 * @param {boolean} param0.readOnly set the mount to readOnly mode
	 */
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
		sdkConfig?: FilenSDKConfig
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
	 * Get the monitor script path.
	 *
	 * @private
	 * @async
	 * @returns {Promise<string>}
	 */
	private async getMonitorScriptPath(): Promise<string> {
		if (!this.monitorScriptPath) {
			this.monitorScriptPath = await writeMonitorScriptAndReturnPath()
		}

		return this.monitorScriptPath
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

					await downloadBinaryAndVerifySHA512(RCLONE_URL, binaryPath, RCLONE_HASHES[rcloneBinaryName]!)

					if (process.platform !== "win32") {
						await execCommand(`chmod +x ${normalizePathForCmd(binaryPath)}`)
					}
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
	 * Get RClone stats.
	 *
	 * @public
	 * @async
	 * @returns {Promise<GetStats>}
	 */
	public async getStats(): Promise<GetStats> {
		if (!this.active) {
			return {
				uploadsInProgress: 0,
				uploadsQueued: 0,
				erroredFiles: 0,
				transfers: []
			}
		}

		try {
			const [coreResponse, vfsResponse] = await Promise.all([
				axios.post(
					`http://127.0.0.1:${this.rclonePort}/core/stats`,
					{},
					{
						responseType: "json",
						timeout: 5000
					}
				),
				axios.post(
					`http://127.0.0.1:${this.rclonePort}/vfs/stats`,
					{},
					{
						responseType: "json",
						timeout: 5000
					}
				)
			])

			const coreData = coreResponse.data as RCCoreStats
			const vfsData = vfsResponse.data as RCVFSStats

			if (
				!vfsData.diskCache ||
				typeof vfsData.diskCache.erroredFiles !== "number" ||
				typeof vfsData.diskCache.uploadsInProgress !== "number" ||
				typeof vfsData.diskCache.uploadsQueued !== "number"
			) {
				return {
					uploadsInProgress: 0,
					uploadsQueued: 0,
					erroredFiles: 0,
					transfers: !coreData.transferring || !Array.isArray(coreData.transferring) ? [] : coreData.transferring
				}
			}

			return {
				uploadsInProgress: vfsData.diskCache.uploadsInProgress,
				uploadsQueued: vfsData.diskCache.uploadsQueued,
				erroredFiles: vfsData.diskCache.erroredFiles,
				transfers:
					!coreData.transferring || !Array.isArray(coreData.transferring)
						? []
						: coreData.transferring.map(transfer => ({
								name: typeof transfer.name === "string" ? transfer.name : "",
								size: typeof transfer.size === "number" ? transfer.size : 0,
								speed: typeof transfer.speed === "number" ? transfer.speed : 0
						  }))
			}
		} catch {
			return {
				uploadsInProgress: 0,
				uploadsQueued: 0,
				erroredFiles: 0,
				transfers: []
			}
		}
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
	 * @param {{ endpoint: string; user: string; password: string }} param0
	 * @param {string} param0.endpoint
	 * @param {string} param0.user
	 * @param {string} param0.password
	 * @returns {Promise<void>}
	 */
	private async writeRCloneConfig({ endpoint, user, password }: { endpoint: string; user: string; password: string }): Promise<void> {
		const [obscuredPassword, configPath] = await Promise.all([this.obscureRClonePassword(password), this.getRCloneConfigPath()])
		const content = `[Filen]\ntype = webdav\nurl = ${endpoint}\nvendor = other\nuser = ${user}\npass = ${obscuredPassword}`

		await writeFileAtomic(configPath, content, "utf-8")
	}

	/**
	 * Generate the "rclone (nfs)mount" arguments.
	 *
	 * @private
	 * @async
	 * @param {{
	 * 		cachePath: string
	 * 		configPath: string
	 * 	}} param0
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
			//"--low-level-retries 10",
			//"--retries 10",
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
			//"--transfers 10",
			"--vfs-fast-fingerprint",
			//"--allow-other",
			"--rc",
			`--rc-addr 127.0.0.1:${this.rclonePort}`,
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
		const [binaryPath, configPath, cachePath, monitorScriptPath] = await Promise.all([
			this.getRCloneBinaryPath(),
			this.getRCloneConfigPath(),
			this.getCachePath(),
			this.getMonitorScriptPath()
		])

		if (!(await fs.exists(binaryPath))) {
			throw new Error(`Virtual drive binary not found at ${binaryPath}.`)
		}

		if (!(await fs.exists(configPath))) {
			throw new Error(`Virtual drive config not found at ${configPath}.`)
		}

		await fs.emptyDir(cachePath)

		if (this.logFilePath) {
			if (await fs.exists(this.logFilePath)) {
				const logStats = await fs.stat(this.logFilePath)

				if (logStats.size > 1024 * 1024 * 10) {
					await fs.unlink(this.logFilePath)
				}
			}
		}

		// The monitor process is a pretty dirty workaround to a specific problem.
		// When spawning a child process in an Electron environment the child process does not get killed when the parent process (Electron) exits (nobody knows why).
		// This means the spawned rclone process keeps chugging along while the actual desktop client is already closed -> bad.
		// This is why we start a secondary "monitor" process. This monitor process continuously checks if the parent PID (electron) is still alive.
		// If not, it tries to kill the rclone process, unmount the mountpoints and then exits itself.
		// This makes sure we clean up all of our processes, even if the parent electron process dies and cannot properly clean up on its own.
		await new Promise<void>((resolve, reject) => {
			if (this.monitorProcess) {
				resolve()

				return
			}

			let errored = false

			this.monitorProcess = spawn(
				process.platform === "win32" ? "cmd.exe" : "sh",
				process.platform === "win32"
					? ["/c", normalizePathForCmd(monitorScriptPath), process.pid.toString(), rcloneBinaryName]
					: [normalizePathForCmd(monitorScriptPath), process.pid.toString(), rcloneBinaryName, `"${this.mountPoint}"`],
				{
					detached: false,
					shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
					stdio: "ignore"
				}
			)

			this.monitorProcess.unref()

			this.monitorProcess.on("error", err => {
				errored = true

				this.monitorProcess = null

				reject(err)
			})

			this.monitorProcess.on("exit", () => {
				errored = true

				this.monitorProcess = null

				reject(new Error("Could not spawn monitor process."))
			})

			this.monitorProcess.on("spawn", () => {
				setTimeout(() => {
					if (errored) {
						reject(new Error("Could not spawn monitor process."))

						return
					}

					resolve()
				}, 1000)
			})
		})

		const [rcPort] = await findFreePorts(1)

		if (!rcPort) {
			throw new Error("Could not find a free port for RC.")
		}

		this.rclonePort = rcPort

		const args = await this.rcloneArgs({
			cachePath,
			configPath
		})

		await new Promise<void>((resolve, reject) => {
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
				clearInterval(checkInterval)
				clearTimeout(checkTimeout)

				try {
					if ((await this.isMountActuallyActive()) && rcloneSpawned) {
						clearInterval(checkInterval)
						clearTimeout(checkTimeout)

						resolve()

						return
					}

					await this.stop()

					reject(new Error("Could not start virtual drive."))
				} catch (e) {
					reject(e)
				}
			}, 15000)

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

				this.rcloneProcess = null

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

			this.rcloneProcess?.kill("SIGKILL")

			if (this.rcloneProcess.pid) {
				await killProcessByPid(this.rcloneProcess.pid).catch(() => {})
			}
		}

		await killProcessByName(rcloneBinaryName).catch(() => {})

		if (process.platform === "linux" || process.platform === "darwin") {
			const umountCmd =
				process.platform === "darwin"
					? `umount -f ${normalizePathForCmd(this.mountPoint)}`
					: `fusermount -uzq ${normalizePathForCmd(this.mountPoint)}`
			const listCmd = `mount -t ${process.platform === "linux" ? "fuse.rclone" : "nfs"}`
			const listedMounts = await execCommand(listCmd)

			if (listedMounts.length > 0 && listedMounts.includes(this.mountPoint)) {
				await execCommand(umountCmd).catch(() => {})
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

			const [webdavPort] = await findFreePorts(1)

			if (!webdavPort) {
				throw new Error("Could not find a free port.")
			}

			this.webdavPort = webdavPort
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

			await this.writeRCloneConfig({
				user: this.webdavUsername,
				password: this.webdavPassword,
				endpoint: this.webdavEndpoint
			})

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
			await this.cleanupRClone()

			const webdavOnline = await this.isWebDAVOnline()

			if (webdavOnline && this.webdavServer?.serverInstance) {
				await this.webdavServer?.stop(true)
			}

			this.webdavServer = null
			this.rcloneProcess = null
			this.active = false
		} finally {
			this.stopMutex.release()
		}
	}
}

export * from "./utils"
export default VirtualDrive

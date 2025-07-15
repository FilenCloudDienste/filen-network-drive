import FilenSDK, { type FilenSDKConfig } from "@filen/sdk"
import { Semaphore, type ISemaphore } from "./semaphore"
import WebDAVServer from "@filen/webdav"
import { spawn, type ChildProcess, exec } from "child_process"
import {
	platformConfigPath,
	downloadBinaryAndVerifySHA512,
	checkIfMountExists,
	killProcessByPid,
	killProcessByName,
	isFUSE3InstalledOnLinux,
	isFUSETInstalledOnMacOS,
	isWinFSPInstalled,
	getAvailableCacheSize,
	getAvailableDriveLetters,
	execCommand,
	isUnixMountPointValid,
	isUnixMountPointEmpty,
	generateRandomString,
	httpHealthCheck,
	normalizePathForCmd,
	isMacFUSEInstalled
} from "./utils"
import pathModule from "path"
import fs from "fs-extra"
import { findFreePort } from "./ports"
import writeFileAtomic from "write-file-atomic"
import axios from "axios"
import { type RCCoreStats, type RCVFSStats, type GetStats } from "./types"
import { writeMonitorScriptAndReturnPath } from "./monitor"
import Logger from "./logger"
import sudoPrompt from "@vscode/sudo-prompt"
import os from "os"

export const RCLONE_VERSION = "1680"
export const FUSE_T_VERSION = "1044"
export const FUSE_T_VERSION_NUMBER = 1000044
export const WINFSP_VERSION = "2124255"
export const RCLONE_BINARY_NAME = `filen_rclone_${process.platform}_${process.arch}_${RCLONE_VERSION}${
	process.platform === "win32" ? ".exe" : ""
}`
export const FUSE_T_BINARY_NAME = `fuse_t_${FUSE_T_VERSION}.pkg`
export const WINFSP_BINARY_NAME = `winfsp_${WINFSP_VERSION}.msi`
export const RCLONE_URL = `https://cdn.filen.io/@filen/desktop/bin/rclone/${RCLONE_BINARY_NAME}`
export const FUSE_T_URL = `https://cdn.filen.io/@filen/desktop/bin/fuse-t/${FUSE_T_BINARY_NAME}`
export const WINFSP_URL = `https://cdn.filen.io/@filen/desktop/bin/winfsp/${WINFSP_BINARY_NAME}`
export const BINARY_HASHES: Record<string, string> = {
	filen_rclone_darwin_arm64_1680:
		"9a92a9ce8addf55cd5a25c7a6ec2d1ac05d24cb1c68afa49f926db837a251944be03920e2c124d35da31e9abe93c690cc4019d716f732aa3396ab16ab9194cf4",
	filen_rclone_darwin_x64_1680:
		"ace3ec98ea8625e87f8097a246ce937732acf22766174a53515066138e5c0d55e25e85a99bc8b2b622648f58650ee918b4606724111082c258f093e77d905c35",
	filen_rclone_linux_arm64_1680:
		"527dd1d983f3f3d6530eb3d820a36bdcb1908c67c37be73a33669a5a6481fb0bd64155816ab437420c26dbb147ac9a0688e3704c3550f5ef80704483bd382e4d",
	filen_rclone_linux_ia32_1680:
		"b017e5cf3c7fc5ab06936c4e923dd281fbb2332f856c07e2e5ebc0e4fb1ad7c94f62a0baf6824c09cba30f90c678b1374681177b6d49b7ae2ffd9b80d7198991",
	filen_rclone_linux_x64_1680:
		"5d20f5562609695b565d696980bbee91ec0503ed946410eb2e6024a8b6850ebd5b587d5c71488f471012ea39e6bf440d843840165e8ac75cd0ec737defa2a749",
	"filen_rclone_win32_arm64_1680.exe":
		"40e33bd06be605727e24bcfcb5beb95463b1962e61f9b37518f5407fa7f3c576f492a8737d1f6c15b41715194a0cc4c4f904146b524af2c1d4d42c19278f2057",
	"filen_rclone_win32_ia32_1680.exe":
		"2338009b0244a7f6573f4cc9cc01b49a3073cae566c2e26a82688fac6aaf36f67a27ee7524e8e3e65f28954c8ae927ff1710f77c07b2c356f0d6c49e72adabe6",
	"filen_rclone_win32_x64_1680.exe":
		"55ece9582bbbc4339494d3d0611b30187bd5e49f7b593c7baa46a156256055273c5c7751124b90c9e66b990effeaf9ac0a6155ecd777dd9791b848a4f7c3c287",
	"fuse_t_1044.pkg":
		"8304c63661b5bd1c35cd2dc506429defab2608799a5da146443f18c8a6462f8f5e741f44334fe8abc6ff0ec92018b3ef8dbaab579fbd1e074b38db2fb4cb7b98",
	"winfsp_2124255.msi":
		"1ca6facd9d1702e52795bbb7933ee0070be800a2cff1261976714cf901edc4845858b98ae9be934da0125fc20b5c1a57a17d6fd50330e168688f32d8ad6304fb"
}

export const excludePatterns = [
	// macOS
	".DS_Store",
	"._.DS_Store",
	"*.DS_Store*",
	"*.nfs.*",
	"._*",
	"*._*",
	".Trashes/**",
	".Spotlight-V100/**",
	".TemporaryItems/**",
	// Windows
	"*.tmp",
	"~*",
	"Thumbs.db",
	"desktop.ini",
	// Linux
	".Trash*",
	"*.swp",
	"*.temp",
	".*.swx"
]

/**
 * Description placeholder
 *
 * @export
 * @class NetworkDrive
 * @typedef {NetworkDrive}
 */
export class NetworkDrive {
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
	private readonly logFilePath: string | undefined
	private readonly readOnly: boolean
	private rclonePort: number = 1906
	private monitorScriptPath: string | null = null
	public logger: Logger
	private readonly tryToInstallDependenciesOnStart: boolean

	/**
	 * Creates an instance of NetworkDrive.
	 *
	 * @constructor
	 * @public
	 * @param {{
	 * 		sdk?: FilenSDK
	 * 		sdkConfig?: FilenSDKConfig
	 * 		mountPoint: string
	 * 		logFilePath?: string
	 * 		readOnly?: boolean
	 * 		disableLogging?: boolean,
	 * 		tryToInstallDependenciesOnStart?: boolean
	 * 	}} param0
	 * @param {FilenSDK} param0.sdk
	 * @param {FilenSDKConfig} param0.sdkConfig
	 * @param {string} param0.mountPoint
	 * @param {string} param0.logFilePath
	 * @param {boolean} [param0.readOnly=false]
	 * @param {boolean} [param0.disableLogging=false]
	 * @param {boolean} [param0.tryToInstallDependenciesOnStart=false]
	 */
	public constructor({
		sdk,
		sdkConfig,
		mountPoint,
		logFilePath,
		readOnly = false,
		disableLogging = false,
		tryToInstallDependenciesOnStart = false,
		cachePath
	}: {
		sdk?: FilenSDK
		sdkConfig?: FilenSDKConfig
		mountPoint: string
		logFilePath?: string
		readOnly?: boolean
		disableLogging?: boolean
		tryToInstallDependenciesOnStart?: boolean
		cachePath?: string
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
		this.mountPoint = mountPoint
		this.logFilePath = logFilePath
		this.readOnly = readOnly
		this.cachePath = cachePath
		this.tryToInstallDependenciesOnStart = tryToInstallDependenciesOnStart
		this.logger = new Logger(disableLogging, false)

		// Start downloading the binary in the background
		this.getRCloneBinaryPath().catch(() => {})
		// Start montioring the mount in the background
		this.monitor().catch(() => {})
	}

	/**
	 * Monitor the network drive in the background.
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
		} catch (e) {
			this.logger.log("error", e, "monitor")
			this.logger.log("error", e)
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
	 * Install WinFSP if it's not installed yet.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async installWinFSPWindows(): Promise<void> {
		if (!this.tryToInstallDependenciesOnStart || process.platform !== "win32" || (await isWinFSPInstalled())) {
			return
		}

		if (!BINARY_HASHES[WINFSP_BINARY_NAME]) {
			throw new Error("WinFSP binary hash not found.")
		}

		const tempPath = pathModule.join(os.tmpdir(), WINFSP_BINARY_NAME)

		await downloadBinaryAndVerifySHA512(WINFSP_URL, tempPath, BINARY_HASHES[WINFSP_BINARY_NAME]!)

		try {
			await new Promise<void>((resolve, reject) => {
				exec(`"%SYSTEMROOT%/System32/WindowsPowerShell/v1.0/powershell.exe" -Command "Start-Process msiexec -ArgumentList '/i ${tempPath} /qn' -Verb runAs -Wait"`, err => {
					if (err) {
						this.logger.log("warn", "powershell not at '%SYSTEMROOT%/System32/WindowsPowerShell/v1.0/powershell.exe', falling back to CommandPrompt (cmd)")
						// Fallback, using cmd prompt
						exec(`cmd /B runas /user:Administrator "msiexec /i ${tempPath} /qn"`, err => {
							if (err) {
								this.logger.log("error", "Fallback failed, WinFSP failed to check")
								reject(err)
								return
							}
						})
					}

					resolve()
				})
			})
		} finally {
			await fs.rm(tempPath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			})
		}
	}

	/**
	 * Download FUSE-T if it's not installed yet.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async installFuseTMacOS(): Promise<void> {
		if (!this.tryToInstallDependenciesOnStart || process.platform !== "darwin" || (await isFUSETInstalledOnMacOS())) {
			return
		}

		if (!BINARY_HASHES[FUSE_T_BINARY_NAME]) {
			throw new Error("FUSE-T binary hash not found.")
		}

		const tempPath = pathModule.join(os.tmpdir(), FUSE_T_BINARY_NAME)

		await downloadBinaryAndVerifySHA512(FUSE_T_URL, tempPath, BINARY_HASHES[FUSE_T_BINARY_NAME]!)

		try {
			await new Promise<void>((resolve, reject) => {
				sudoPrompt.exec(
					`osascript -e 'do shell script "/usr/sbin/installer -pkg ${tempPath} -target /" with administrator privileges'`,
					{
						name: "Filen"
					},
					(err, stdout, stderr) => {
						if (err) {
							reject(err)

							return
						}

						if (
							(stderr instanceof Buffer && stderr.toString("utf-8").toLowerCase().includes("the install was successful")) ||
							(stdout instanceof Buffer && stdout.toString("utf-8").toLowerCase().includes("the install was successful")) ||
							(stderr instanceof Buffer && stderr.toString("utf-8").toLowerCase().includes("the upgrade was successful")) ||
							(stdout instanceof Buffer && stdout.toString("utf-8").toLowerCase().includes("the upgrade was successful")) ||
							(typeof stderr === "string" && stderr.toLowerCase().includes("the install was successful")) ||
							(typeof stdout === "string" && stdout.toLowerCase().includes("the install was successful")) ||
							(typeof stderr === "string" && stderr.toLowerCase().includes("the upgrade was successful")) ||
							(typeof stdout === "string" && stdout.toLowerCase().includes("the upgrade was successful"))
						) {
							resolve()

							return
						}

						reject(new Error("Could not install fuse-t."))
					}
				)
			})
		} finally {
			await fs.rm(tempPath, {
				force: true,
				maxRetries: 60 * 10,
				recursive: true,
				retryDelay: 100
			})
		}
	}

	/**
	 * Add Filen as a host entry for localhost. Used for macOS fuse-t.
	 *
	 * @private
	 * @async
	 * @returns {Promise<void>}
	 */
	private async addHostsEntry(): Promise<void> {
		if (process.platform !== "darwin") {
			return
		}

		try {
			if (process.platform === "darwin") {
				const hosts = await fs.readFile("/etc/hosts", "utf-8")
				const hostLines = hosts.split("\n")
				const foundHostEntry = hostLines.some(line => {
					line = line.trim().split(" ").join("")

					return line.includes("127.0.0.1") && line.includes("Filen") && !line.includes("#")
				})

				if (!foundHostEntry) {
					await new Promise<void>((resolve, reject) => {
						sudoPrompt.exec(
							// eslint-disable-next-line quotes
							`sh -c 'echo "127.0.0.1 Filen" >> /etc/hosts'`,
							{
								name: "Filen"
							},
							err => {
								if (err) {
									reject(err)

									return
								}

								resolve()
							}
						)
					})
				}
			}
		} catch {
			// Noop
		}
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
				const binaryPath = pathModule.join(configPath, RCLONE_BINARY_NAME)

				if (!(await fs.exists(binaryPath))) {
					if (!BINARY_HASHES[RCLONE_BINARY_NAME]) {
						throw new Error(`Hash for binary name ${RCLONE_BINARY_NAME} not found in hardcoded record.`)
					}

					await downloadBinaryAndVerifySHA512(RCLONE_URL, binaryPath, BINARY_HASHES[RCLONE_BINARY_NAME]!)

					if (process.platform !== "win32") {
						await execCommand(`chmod +x ${normalizePathForCmd(binaryPath)}`)
					}
				}

				this.rcloneBinaryPath = binaryPath
			} catch (e) {
				this.logger.log("error", e, "getRCloneBinaryPath")
				this.logger.log("error", e)

				throw e
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
	 * List all active VFSes from rclone.
	 *
	 * @public
	 * @async
	 * @returns {Promise<string[]>}
	 */
	public async vfsList(): Promise<string[]> {
		try {
			const response = await axios.post(
				`http://127.0.0.1:${this.rclonePort}/vfs/list`,
				{},
				{
					responseType: "json",
					timeout: 5000
				}
			)

			const vfsList = response.data as { vfses: string[] }

			return vfsList.vfses
		} catch {
			return []
		}
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
		if (!this.rcloneProcess) {
			return false
		}

		try {
			const [mountExists, vfsList, webdavOnline] = await Promise.all([
				checkIfMountExists(this.mountPoint),
				this.vfsList(),
				this.isWebDAVOnline()
			])

			if (!mountExists || !webdavOnline) {
				return false
			}

			return vfsList.includes("Filen:")
		} catch (e) {
			this.logger.log("error", e, "isMountActuallyActive")
			this.logger.log("error", e)

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
	 * Generate the "rclone mount" arguments.
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
		const [availableCacheSize, macFUSEInstalled] = await Promise.all([getAvailableCacheSize(cachePath), isMacFUSEInstalled()])
		const osDiskBufferGib = 5
		const availableCacheSizeGib = Math.floor(availableCacheSize / (1024 * 1024 * 1024)) - osDiskBufferGib
		const cacheSize = availableCacheSizeGib > 0 ? availableCacheSizeGib : osDiskBufferGib

		return [
			`mount Filen: "${this.mountPoint}"`,
			`--config "${configPath}"`,
			"--vfs-cache-mode full",
			...(this.readOnly ? ["--read-only"] : []),
			`--cache-dir "${cachePath}"`,
			`--vfs-cache-max-size "${cacheSize}Gi"`,
			"--vfs-cache-min-free-space 5Gi",
			"--vfs-cache-max-age 720h",
			"--vfs-cache-poll-interval 1m",
			"--dir-cache-time 3s",
			"--cache-info-age 5s",
			//"--noappledouble",
			//"--noapplexattr",
			"--no-gzip-encoding",
			"--use-mmap",
			//"--allow-other",
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
			"--rc",
			`--rc-addr "127.0.0.1:${this.rclonePort}"`,
			...(this.logFilePath ? [`--log-file "${this.logFilePath}"`] : []),
			"--devname Filen",
			...(process.platform === "win32" ? ["--volname \\\\Filen\\Filen"] : ["--volname Filen"]),
			...(process.platform === "win32"
				? // eslint-disable-next-line quotes
				  ['-o FileSecurity="D:P(A;;FA;;;WD)"', "--network-mode"]
				: []),
			// Only for FUSE-T
			...(process.platform === "darwin"
				? macFUSEInstalled
					? ["-o jail_symlinks"]
					: ["-o nomtime", "-o backend=nfs", "-o location=Filen", "-o nonamedattr"]
				: [])
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
			throw new Error(`Network drive binary not found at ${binaryPath}.`)
		}

		if (!(await fs.exists(configPath))) {
			throw new Error(`Network drive config not found at ${configPath}.`)
		}

		await fs.rm(cachePath, {
			force: true,
			maxRetries: 60 * 10,
			recursive: true,
			retryDelay: 100
		})

		await fs.ensureDir(cachePath)

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
				process.platform === "win32" ? normalizePathForCmd(monitorScriptPath) : "sh",
				process.platform === "win32"
					? [process.pid.toString(), RCLONE_BINARY_NAME]
					: [normalizePathForCmd(monitorScriptPath), process.pid.toString(), RCLONE_BINARY_NAME, `"${this.mountPoint}"`],
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

				reject(new Error("Could not spawn monitor process (exit)."))
			})

			this.monitorProcess.on("spawn", () => {
				setTimeout(() => {
					if (errored) {
						reject(new Error("Could not spawn monitor process (spawn)."))

						return
					}

					resolve()
				}, 1000)
			})
		})

		const rcPort = await findFreePort()

		if (!rcPort) {
			throw new Error("Could not find a free port for RC.")
		}

		this.rclonePort = rcPort

		const args = await this.rcloneArgs({
			cachePath,
			configPath
		})
		const binaryPathNormalized = normalizePathForCmd(binaryPath)

		this.logger.log("info", `Rclone args: '${binaryPathNormalized} ${args.join(" ")}'`)

		await new Promise<void>((resolve, reject) => {
			let checkInterval: NodeJS.Timeout | undefined = undefined
			let checkTimeout: NodeJS.Timeout | undefined = undefined

			checkInterval = setInterval(async () => {
				try {
					if (await this.isMountActuallyActive()) {
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
					if (await this.isMountActuallyActive()) {
						resolve()

						return
					}

					await this.stop()

					reject(new Error("Could not start network drive (timeout)."))
				} catch (e) {
					reject(e)
				}
			}, 30000)

			this.rcloneProcess = spawn(binaryPathNormalized, args, {
				stdio: "ignore",
				shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
				detached: false
			})

			this.rcloneProcess.on("error", err => {
				this.rcloneProcess = null

				clearInterval(checkInterval)
				clearTimeout(checkTimeout)

				reject(err)
			})

			this.rcloneProcess.on("exit", () => {
				this.rcloneProcess = null

				clearInterval(checkInterval)
				clearTimeout(checkTimeout)

				reject(new Error("Could not start network drive (exit)."))
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

			this.rcloneProcess?.kill("SIGTERM")

			await new Promise<void>(resolve => setTimeout(resolve, 1000))

			if (this.rcloneProcess.pid) {
				await killProcessByPid(this.rcloneProcess.pid).catch(() => {})
			}
		}

		await killProcessByName(RCLONE_BINARY_NAME).catch(() => {})

		if (process.platform === "linux" || process.platform === "darwin") {
			await execCommand(
				process.platform === "darwin" ? `umount -f "${this.mountPoint}"` : `fusermount -uzq "${this.mountPoint}"`
			).catch(() => {})
		}
	}

	/**
	 * Start the network drive.
	 *
	 * @public
	 * @async
	 * @returns {Promise<void>}
	 */
	public async start(): Promise<void> {
		await this.startMutex.acquire()

		try {
			await this.stop()

			if (this.tryToInstallDependenciesOnStart) {
				if (process.platform === "darwin" && !(await isMacFUSEInstalled())) {
					await this.installFuseTMacOS()
					await this.addHostsEntry()
				}

				if (process.platform === "win32") {
					await this.installWinFSPWindows()
				}
			}

			if (process.platform === "win32" && !(await isWinFSPInstalled())) {
				throw new Error("WinFSP not installed.")
			}

			if (process.platform === "linux" && !(await isFUSE3InstalledOnLinux())) {
				throw new Error("FUSE3 not installed.")
			}

			if (process.platform === "darwin" && !(await isFUSETInstalledOnMacOS())) {
				throw new Error("FUSE-T not installed.")
			}

			if (process.platform === "win32") {
				const availableDriveLetters = await getAvailableDriveLetters()

				if (!availableDriveLetters.includes(this.mountPoint)) {
					throw new Error(`Cannot mount network drive at ${this.mountPoint}: Drive letter exists.`)
				}
			} else {
				if ((process.platform === "linux" || process.platform === "darwin") && this.mountPoint.includes("$")) {
					throw new Error("Only absolute paths for mount points are supported.")
				}

				if (process.platform === "linux" && !this.mountPoint.startsWith(os.homedir() + "/")) {
					throw new Error("Cannot mount to a directory outside of your home directory.")
				}

				if (process.platform === "darwin" && !this.mountPoint.startsWith(os.homedir() + "/")) {
					throw new Error("Cannot mount to a directory outside of your user directory.")
				}

				if (!(await isUnixMountPointValid(this.mountPoint))) {
					throw new Error(`Cannot mount network drive at ${this.mountPoint}: Mount point does not exist.`)
				}

				if (!(await isUnixMountPointEmpty(this.mountPoint))) {
					throw new Error(`Cannot mount network drive at ${this.mountPoint}: Mount point not empty.`)
				}
			}

			const webdavPort = await findFreePort()

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
				authMode: "basic",
				rateLimit: {
					windowMs: 1000,
					limit: 10000,
					key: "ip"
				},
				tempFilesToStoreOnDisk: excludePatterns
			})

			await this.webdavServer.start()

			await this.writeRCloneConfig({
				user: this.webdavUsername,
				password: this.webdavPassword,
				endpoint: this.webdavEndpoint
			})

			await this.spawnRClone()

			if (!(await this.isMountActuallyActive())) {
				throw new Error("Could not start network drive (not active).")
			}

			this.active = true
		} catch (e) {
			this.logger.log("error", e, "start")
			this.logger.log("error", e)

			throw e
		} finally {
			this.startMutex.release()
		}
	}

	/**
	 * Stop the network drive.
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
		} catch (e) {
			this.logger.log("error", e, "stop")
			this.logger.log("error", e)

			throw e
		} finally {
			this.stopMutex.release()
		}
	}
}

export * from "./utils"
export default NetworkDrive
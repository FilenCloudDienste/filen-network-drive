import axios from "axios"
import fs from "fs-extra"
import crypto from "crypto"
import path from "path"
import os from "os"

/**
 * Downloads a file from the specified URL and saves it to a temporary file.
 * @param {string} url - The URL of the file to download.
 * @returns {Promise<string>} - A promise that resolves to the path of the downloaded temporary file.
 */
async function downloadFile(url) {
	const tmpDir = os.tmpdir()
	const tmpFilePath = path.join(tmpDir, `downloaded-file-${Date.now()}`)

	const writer = fs.createWriteStream(tmpFilePath)

	const response = await axios({
		method: "get",
		url: url,
		responseType: "stream"
	})

	response.data.pipe(writer)

	return new Promise((resolve, reject) => {
		writer.on("finish", () => resolve(tmpFilePath))
		writer.on("error", reject)
	})
}

/**
 * Computes the SHA-512 hash of a file.
 * @param {string} filePath - The path to the file.
 * @returns {Promise<string>} - A promise that resolves to the SHA-512 hash of the file.
 */
function computeSHA512(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha512")
		const stream = fs.createReadStream(filePath)

		stream.on("data", data => hash.update(data))
		stream.on("end", () => resolve(hash.digest("hex")))
		stream.on("error", reject)
	})
}

/**
 * Downloads multiple files from URLs, computes their SHA-512 hashes, and removes the temporary files.
 * Outputs the result as a record: Record<URL, hash>.
 * @param {string[]} urls - An array of URLs to download files from.
 * @returns {Promise<Record<string, string>>} - A promise that resolves to a record of URL to hash.
 */
async function downloadAndHashMultiple(urls) {
	const result = {}

	for (const url of urls) {
		try {
			console.log(`Downloading file from: ${url}`)
			const tmpFilePath = await downloadFile(url)

			console.log(`Computing SHA-512 hash for: ${tmpFilePath}`)
			const hash = await computeSHA512(tmpFilePath)
			console.log(`SHA-512 hash for ${url}: ${hash}`)

			// Add the hash to the result record
			result[
				url
					.split("https://cdn.filen.io/@filen/desktop/bin/fuse-t/")
					.join("")
					.split("https://cdn.filen.io/@filen/desktop/bin/rclone/")
					.join("")
			] = hash

			// Remove the temporary file
			fs.unlinkSync(tmpFilePath)
			console.log(`Temporary file ${tmpFilePath} removed.`)
		} catch (error) {
			console.error(`Error processing ${url}:`, error)
		}
	}

	return result
}

const rcloneVersion = "1680"
const fuseTVersion = "1041"
const urls = [
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_darwin_arm64_" + rcloneVersion,
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_darwin_x64_" + rcloneVersion,
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_linux_arm64_" + rcloneVersion,
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_linux_ia32_" + rcloneVersion,
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_linux_x64_" + rcloneVersion,
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_win32_arm64_" + rcloneVersion + ".exe",
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_win32_ia32_" + rcloneVersion + ".exe",
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_win32_ia32_" + rcloneVersion + ".exe",
	"https://cdn.filen.io/@filen/desktop/bin/rclone/filen_rclone_win32_x64_" + rcloneVersion + ".exe",
	"https://cdn.filen.io/@filen/desktop/bin/fuse-t/fuse_t_" + fuseTVersion + ".pkg"
]

downloadAndHashMultiple(urls).then(hashes => {
	console.log(hashes)
})

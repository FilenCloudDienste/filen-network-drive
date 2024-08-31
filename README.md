<br/>
<p align="center">
  <h3 align="center">Filen Virtual Drive</h3>

  <p align="center">
    A package to mount a Filen account as a virtual drive.
    <br/>
    <br/>
  </p>
</p>

![Contributors](https://img.shields.io/github/contributors/FilenCloudDienste/filen-virtual-drive?color=dark-green) ![Forks](https://img.shields.io/github/forks/FilenCloudDienste/filen-virtual-drive?style=social) ![Stargazers](https://img.shields.io/github/stars/FilenCloudDienste/filen-virtual-drive?style=social) ![Issues](https://img.shields.io/github/issues/FilenCloudDienste/filen-virtual-drive) ![License](https://img.shields.io/github/license/FilenCloudDienste/filen-virtual-drive)

# Attention

The package is still a work in progress. DO NOT USE IT IN PRODUCTION YET. Class names, function names, types, definitions, constants etc. are subject to change until we release a fully tested and stable version.

### Installation

1. Install using NPM

```sh
npm install @filen/virtual-drive@latest
```

2. Initialize the virtual drive

```typescript
import FilenSDK from "@filen/sdk"
import VirtualDrive from "@filen/virtual-drive"
import path from "path"
import os from "os"

// Initialize a SDK instance (optional)
const filen = new FilenSDK({
	metadataCache: true,
	connectToSocket: true,
	tmpPath: path.join(os.tmpdir(), "filen-sdk")
})

await filen.login({
	email: "your@email.com",
	password: "supersecret123",
	twoFactorCode: "123456"
})

const virtualDrive = new VirtualDrive({
	sdk: filen,
	mountPoint: "X:" // or /path/to/mount on Linux/macOS
})

virtualDrive
	.start()
	.then(() => {
		console.log("Virtual drive started")
	})
	.catch(console.error)
```

## License

Distributed under the AGPL-3.0 License. See [LICENSE](https://github.com/FilenCloudDienste/filen-virtual-drive/blob/main/LICENSE.md) for more information.

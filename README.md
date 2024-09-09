<br/>
<p align="center">
  <h3 align="center">Filen Network Drive</h3>

  <p align="center">
    A package to mount a Filen account as a network drive.
    <br/>
    <br/>
  </p>
</p>

![Contributors](https://img.shields.io/github/contributors/FilenCloudDienste/filen-network-drive?color=dark-green) ![Forks](https://img.shields.io/github/forks/FilenCloudDienste/filen-network-drive?style=social) ![Stargazers](https://img.shields.io/github/stars/FilenCloudDienste/filen-network-drive?style=social) ![Issues](https://img.shields.io/github/issues/FilenCloudDienste/filen-network-drive) ![License](https://img.shields.io/github/license/FilenCloudDienste/filen-network-drive)

# Attention

The package is still a work in progress. DO NOT USE IT IN PRODUCTION YET. Class names, function names, types, definitions, constants etc. are subject to change until we release a fully tested and stable version.

### Installation

1. Install using NPM

```sh
npm install @filen/network-drive@latest
```

2. Initialize the network drive

```typescript
import FilenSDK from "@filen/sdk"
import NetworkDrive from "@filen/network-drive"
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

const networkDrive = new NetworkDrive({
	sdk: filen,
	mountPoint: "X:" // or /path/to/mount on Linux/macOS
})

await networkDrive.start()

console.log("Network drive started")
```

## License

Distributed under the AGPL-3.0 License. See [LICENSE](https://github.com/FilenCloudDienste/filen-network-drive/blob/main/LICENSE.md) for more information.

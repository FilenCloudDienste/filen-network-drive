import pathModule from "path"
import writeFileAtomic from "write-file-atomic"
import { platformConfigPath, execCommand } from "./utils"
import fs from "fs-extra"

export const MONITOR_VERSION = 3

export const windowsMonitor = `@echo off
setlocal

:: Check if required arguments are provided
if "%~1"=="" (
    echo Error: No PID provided.

    exit /B 1
)

if "%~2"=="" (
    echo Error: No process name provided.

    exit /B 1
)

:: Set the target PID and process name from command-line arguments
set "TARGET_PID=%~1"
set "PROCESS_NAME_TO_KILL=%~2"

:: Use PowerShell to wait for the process to exit
powershell -Command "Try { Wait-Process -Id %TARGET_PID% -ErrorAction Stop } Catch { Exit }"

:: Once the process with TARGET_PID exits, kill the process by name
taskkill /F /IM "%PROCESS_NAME_TO_KILL%" >nul 2>&1

:end
exit /B

`

export const unixMonitor = `#!/bin/sh

# Check if required arguments are provided
if [ -z "$1" ]; then
  echo "Error: No PID provided."

  exit 1
fi

if [ -z "$2" ]; then
  echo "Error: No process name provided."

  exit 1
fi

if [ -z "$3" ]; then
  echo "Error: No mount point provided."
  
  exit 1
fi

# Set the target PID and process name from command-line arguments
TARGET_PID="$1"
PROCESS_NAME_TO_KILL="$2"
MOUNT_POINT="$3"

# Determine platform-specific umount command
if [ "$(uname)" = "Darwin" ]; then
  UMOUNT_CMD="umount -f"
else
  UMOUNT_CMD="fusermount -uzq"  # Use fusermount for Linux
fi

# Loop until the target PID is no longer running
while ps -p "$TARGET_PID" > /dev/null 2>&1; do
  # Wait
  sleep 3
done

# After the process exits, kill the specified process by name (if still running)
pkill -9 "$PROCESS_NAME_TO_KILL" > /dev/null 2>&1 || true

$UMOUNT_CMD "$MOUNT_POINT" > /dev/null 2>&1 || true

exit 0

`

export async function writeMonitorScriptAndReturnPath(): Promise<string> {
	const configPath = await platformConfigPath()
	const monitorPath = pathModule.join(configPath, `monitor.v${MONITOR_VERSION}.${process.platform === "win32" ? "bat" : "sh"}`)

	if (!(await fs.exists(monitorPath))) {
		await writeFileAtomic(monitorPath, process.platform === "win32" ? windowsMonitor : unixMonitor, "utf-8")
	}

	if (process.platform !== "win32") {
		await execCommand(`chmod +x "${monitorPath}"`)
	}

	return monitorPath
}

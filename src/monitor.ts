import pathModule from "path"
import writeFileAtomic from "write-file-atomic"
import { platformConfigPath } from "./utils"
import fs from "fs-extra"

export const MONITOR_VERSION = 1

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

:loop
:: Check if the parentProcess with the target PID is running
tasklist /FI "PID eq %TARGET_PID%" | find /I "%TARGET_PID%" >nul 2>&1

:: If the parentProcess is not found, kill the process by name
if errorlevel 1 (
    :: If the process exists or not does not matter, simply kill it or continue
    taskkill /F /IM "%PROCESS_NAME_TO_KILL%" >nul 2>&1

    goto :end
)

:: Wait for 3 seconds
timeout /t 3 /nobreak >nul

:: Repeat the check
goto :loop

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

# Set the target PID and process name from command-line arguments
TARGET_PID="$1"
PROCESS_NAME_TO_KILL="$2"
MOUNT_POINT="$3"

# Determine platform-specific umount command
if [ "$(uname)" = "Darwin" ]; then
  UMOUNT_CMD="umount -f"
  MOUNT_TYPE="nfs"
else
  UMOUNT_CMD="fusermount -uzq"  # Use fusermount for Linux
  MOUNT_TYPE="fuse.rclone"
fi

while true; do
  # Check if the process with the target PID is running
  if ! ps -p "$TARGET_PID" > /dev/null 2>&1; then
    kill -9 "$PROCESS_NAME_TO_KILL" > /dev/null 2>&1 || true

    # List current mounts
    LISTED_MOUNTS=$(mount -t "$MOUNT_TYPE")

    if echo "$LISTED_MOUNTS" | grep -q "$MOUNT_POINT"; then
      $UMOUNT_CMD "$MOUNT_POINT" > /dev/null 2>&1 || true
    fi

    break
  fi

  # Wait for 3 seconds
  sleep 3
done

exit 0

`

export async function writeMonitorScriptAndReturnPath(): Promise<string> {
	const configPath = await platformConfigPath()
	const monitorPath = pathModule.join(configPath, `monitor.v${MONITOR_VERSION}.${process.platform === "win32" ? "bat" : "sh"}`)

	if (!(await fs.exists(monitorPath))) {
		await writeFileAtomic(monitorPath, process.platform === "win32" ? windowsMonitor : unixMonitor, "utf-8")
	}

	return monitorPath
}

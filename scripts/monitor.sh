#!/bin/sh

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

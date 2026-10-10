---
name: android-device-recovery
description: Operate the local androidctl CLI/MCP to inspect, diagnose, transfer, back up, and recover Android devices on Windows.
metadata:
  short-description: Safe Android device recovery workflows
---

# Android device recovery

Use `androidctl devices` before every workflow and select actions only from the reported capabilities.

## Transport rules

- ADB `device`: shell, logs, packages, transfers, diagnostics and scrcpy may be available.
- ADB `unauthorized`: ask the user to authorize USB debugging; do not retry blindly.
- MTP only: restrict operations to user-visible shared storage. Do not claim access to private app data.
- Fastboot: inspect first. Never flash, erase, unlock, or restore without explicit confirmation and `--yes`.
- Broken display: use existing authorization, MTP, recovery or a documented OTG/accessibility path; do not infer that a cable bypasses Android security.

## Backup rules

Prefer encrypted, block-based backups. Preserve the job ID, manifest, hashes and provider state. Resume only from a verified completed block and run integrity verification before reporting success.

Never place Telegram tokens, MTProto API hashes, session files, backup passwords or private keys in prompts, logs, source code or MCP output.

## MCP use

Use read-only tools first: `device_list`, `device_capabilities`, and `device_diagnose`. Use backup tools only with a user-provided destination and encryption secret. Report transport limitations and partial recovery explicitly.

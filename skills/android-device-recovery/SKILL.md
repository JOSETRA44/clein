---
name: android-device-recovery
description: Operate the local androidctl CLI/MCP to diagnose and manage Android devices on Windows — storage, network, permissions, processes, apps, files, logs, shell, encrypted backups and devices with a broken screen.
metadata:
  short-description: Android developer toolkit and safe recovery workflows
---

# Android developer toolkit and recovery

Start with `device_list` (CLI `androidctl devices`) or `health_report` and choose actions only from the reported capabilities. With one device connected the device id may be omitted. MCP prompts `storage_cleanup`, `broken_screen_rescue` and `security_audit` describe the full workflows.

## Transport rules

- ADB `device`: shell, logs, packages, transfers, diagnostics and UI control are available.
- ADB `unauthorized`: ask the user to authorize USB debugging; it cannot be authorized without the screen. Do not retry blindly or suggest ways around it.
- MTP only: restrict operations to user-visible shared storage. Do not claim access to private app data.
- Fastboot: inspect first. Never flash, erase, unlock, or restore without explicit confirmation and `--yes`.
- Wireless: `wireless_pair` (Android 11+, code from the phone) then `wireless_connect`; or `wireless_enable` from a USB connection.

## Diagnosis

- Storage: `storage_analyze`, then `storage_largest`. Recommend the app's own storage manager for private app data; never suggest clearing app data without stating it is permanent.
- Network: `net_status` (gateway, Wi-Fi signal, DNS, VPN, apps listening on the LAN), `net_ping`.
- Security: `perms_audit` ranks apps by sensitive permissions and special access; explain each reason and let the user decide.
- Performance: `device_vitals` and `ps`; `logs_read` with `minLevel`/`tag`/`search` instead of dumping the whole log.

## Broken screen

`screen_status` → `screen_wake` → `ui_dump` to read the screen → `ui_tap` / `input_key` to navigate, describing each screen before acting. If a secure lock is shown, stop and ask the owner to unlock it (e.g. through `androidctl mirror`); androidctl does not enter unlock credentials. Then offer `backup_start`.

## Shell

`shell_exec` runs read-only commands directly. Anything that may change state needs `confirm: true` after the user approves that exact command. Wipe/format commands are always refused — do not try to rephrase them.

## Backup rules

Backups are encrypted, block-based tar archives of a device path. Always run `backup_verify` before reporting success, and report `complete: false` and any `warnings` as partial recovery. Restore locally with `backup_export`, which refuses to overwrite files. Pass the secret through `ANDROIDCTL_BACKUP_SECRET` rather than `--secret`.

Never place Telegram tokens, MTProto API hashes, session files, backup passwords, pairing codes or private keys in prompts, logs, source code or MCP output.

## Safety

Tools annotated `destructiveHint` or taking `confirm` change the device: ask the user first. In `ANDROIDCTL_POLICY=read-only` mode write tools are not offered. Every state-changing call is recorded in the audit log (`audit_log`). Errors carry `error.code` (`VALIDATION`, `NOT_FOUND`, `DEVICE_UNAVAILABLE`, `INTEGRITY`, `EXTERNAL_TOOL`, `CONFIRMATION_REQUIRED`, `POLICY_DENIED`); act on the code instead of retrying blindly.

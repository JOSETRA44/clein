# androidctl

CLI + MCP local para diagnóstico y recuperación de dispositivos Android en Windows 11.

## Desarrollo

```powershell
npm install
npm run build
node dist/cli.js devices
node dist/mcp.js
```

El proyecto detecta automáticamente el SDK Android instalado en `C:\Users\USER\AppData\Local\Android\Sdk\platform-tools`. Se pueden sobrescribir herramientas con `ANDROIDCTL_ADB_PATH`, `ANDROIDCTL_FASTBOOT_PATH` y `ANDROIDCTL_DATA_DIR`.

Telegram requiere una cuenta de usuario MTProto con `TELEGRAM_API_ID` y `TELEGRAM_API_HASH`; un token de bot no se guarda ni se usa para acceder a Mensajes guardados.

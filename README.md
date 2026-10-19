# androidctl

Kit de herramientas para desarrolladores y técnicos Android: una **CLI** con colores, tablas y progreso, y un **servidor MCP** (stdio y Streamable HTTP) para agentes de IA, sobre el mismo núcleo. Diagnostica almacenamiento, red, permisos y procesos; gestiona apps, ficheros, logs y backups cifrados; y permite operar dispositivos **sin pantalla funcional** mediante el árbol de UI, eventos de entrada y scrcpy.

## Inicio rápido

```powershell
npm install
npm run build
node dist/main/cli.js doctor        # adb / fastboot / scrcpy y conexión
node dist/main/cli.js report        # informe de salud completo con puntuación
node dist/main/cli.js report salud.html
```

Con un solo dispositivo conectado no hace falta `--device`. El SDK se detecta en `%LOCALAPPDATA%\Android\Sdk\platform-tools` (o `ANDROID_SDK_ROOT` / `ANDROID_HOME`); se puede sobrescribir con `ANDROIDCTL_ADB_PATH`, `ANDROIDCTL_FASTBOOT_PATH`, `ANDROIDCTL_SCRCPY_PATH` y `ANDROIDCTL_DATA_DIR`. Autocompletado: `androidctl completion powershell | Out-String | Invoke-Expression`.

## Comandos

| Área | Comandos |
|---|---|
| **Diagnóstico** | `devices` · `info` · `diagnose` · `monitor [--watch]` · `report [archivo.html\|.md]` · `doctor` |
| **Almacenamiento** | `storage analyze` · `storage largest [ruta]` · `storage trim-caches --yes` |
| **Red** | `net status [--watch]` (interfaces, gateway, señal Wi-Fi, DNS, DNS privado, VPN, apps escuchando en la red) · `net ping <host>` · `net wifi on\|off` |
| **ADB inalámbrico** | `wireless enable` (USB → Wi-Fi) · `wireless pair <host:puerto> <código>` · `wireless connect` · `wireless disconnect` · `wireless discover` (mDNS) |
| **Puertos** | `ports reverse 3000` (servidor de desarrollo del PC visible en el móvil) · `ports forward 9222 localabstract:chrome_devtools_remote` · `ports list` · `ports remove` |
| **Seguridad** | `perms audit` (apps por riesgo: permisos sensibles + accesibilidad, notificaciones, administrador, superposición…) · `perms show <pkg>` · `perms revoke\|grant <pkg> <permiso> --yes` · `audit` |
| **Apps y procesos** | `apps list\|info\|install\|uninstall\|restore\|launch\|stop\|clear` · `ps [--sort mem] [--watch]` |
| **Ficheros y logs** | `files ls\|pull\|push` (con progreso) · `logs [--min-level E] [--tag T] [--search txt] [--follow]` |
| **Shell** | `shell <comando…>` — los comandos de solo lectura se ejecutan directamente; los que cambian estado piden `--yes`; los que pueden borrar o inutilizar el dispositivo se rechazan siempre |
| **Sin pantalla** | `screen status\|wake\|stay-awake\|timeout\|record` · `ui dump [texto]` · `ui tap --text "Permitir"` · `ui wait --text …` · `input key\|tap\|swipe\|text` · `mirror` (scrcpy) · `reboot [recovery\|bootloader\|sideload] --yes` |
| **Backups** | `backup create\|status\|verify\|export` — AES-256-GCM por bloques, verificables |

Opciones globales: `-d/--device`, `--json`, `-w/--watch` (`--interval s`), `-f/--follow`, `-y/--yes`, `--no-color`, `--` (todo lo siguiente es posicional). `androidctl <grupo>` muestra la ayuda del grupo.

**Salida**: en terminal, colores, tablas y spinners (en stderr); redirigida, JSON (`{ success, data }`); `--follow`/`--watch` emiten NDJSON. `shell` se comporta como una shell: salida en bruto y el código de salida remoto.

**Códigos de salida**: `0` ok · `1` error · `2` entrada inválida · `3` no encontrado · `4` dispositivo no disponible · `5` integridad · `6` falta confirmación · `7` denegado por política.

## Dispositivos con la pantalla rota

Requisito: la depuración USB debe haber sido autorizada antes (adb no puede autorizarse sin pantalla).

1. `androidctl screen status` y `androidctl screen wake`.
2. `androidctl ui dump` lista lo que hay en pantalla (texto, id, coordenadas) aunque no se vea; `androidctl ui tap --text "Aceptar"` pulsa por texto.
3. `androidctl mirror` abre scrcpy para ver y controlar con ratón y teclado (`winget install --exact Genymobile.scrcpy`). Con `--otg`, scrcpy actúa como teclado/ratón USB.
4. Un bloqueo seguro (PIN, patrón, huella) lo desbloquea su propietario, por ejemplo a través de `mirror`; androidctl no introduce credenciales de desbloqueo.
5. Después: `backup create` para rescatar los datos.

## Seguridad

- **Confirmación**: toda operación que cambia el dispositivo exige `--yes` (CLI) o `confirm: true` (MCP); la regla vive en el dominio, no en la interfaz.
- **Política**: `ANDROIDCTL_POLICY=read-only` (o `androidctl-mcp --read-only`) rechaza cualquier escritura; en MCP las herramientas de escritura ni siquiera se anuncian.
- **Auditoría**: cada operación que cambia estado (también las denegadas) se añade a `%LOCALAPPDATA%\androidctl\audit.jsonl` con los secretos redactados; consúltalo con `androidctl audit`.
- **Shell**: clasificación por segmento (`;`, `|`, `&&`), redirecciones y sustitución de comandos cuentan como escritura; límite de salida de 256 KB y tiempo máximo de 600 s.
- **Secretos**: el código de emparejamiento inalámbrico se pasa por stdin (no aparece en la lista de procesos); los secretos de backup se leen de `ANDROIDCTL_BACKUP_SECRET`.
- **MCP HTTP**: solo loopback, token Bearer obligatorio (comparación en tiempo constante), validación de `Host` y `Origin` contra DNS rebinding, cuerpo máximo de 4 MB, modo sin estado.

## MCP

```jsonc
// stdio
{ "mcpServers": { "androidctl": { "command": "node", "args": ["C:/ruta/androidctl/dist/main/mcp.js"] } } }
```

```powershell
# Streamable HTTP para varios clientes locales
$env:ANDROIDCTL_MCP_TOKEN = '<token largo>'
node dist/main/mcp.js --http --port 8765 [--read-only]
# endpoint: http://127.0.0.1:8765/mcp  ·  cabecera: Authorization: Bearer <token>
```

Expone todas las operaciones del catálogo como herramientas con esquemas zod y anotaciones `readOnlyHint`/`destructiveHint`; **resources** (`androidctl://devices`, `androidctl://audit`, `androidctl://device/{id}/report`) y **prompts** guiados (`storage_cleanup`, `broken_screen_rescue`, `security_audit`).

## Arquitectura

Clean Architecture; las dependencias solo apuntan hacia dentro y `test/architecture.test.ts` lo hace cumplir.

```
src/
  domain/          Reglas puras: dispositivos, jobs, backups, almacenamiento, vitales, red, riesgo de permisos,
                   política de shell, selectores de UI, health score, errores tipados
  application/     Casos de uso + puertos segregados por capacidad (StorageProbe, NetworkProbe, PermissionProbe,
                   ProcessProbe, ShellRunner, DeviceInput, UiInspector, ScreenControl, MirrorLauncher, AuditLog…)
  infrastructure/  Adaptadores: adb (parsers puros + probes), scrcpy, crypto de Node, ficheros, auditoría, configuración
  presentation/
    catalog.ts       Fuente única de cada operación (esquema, seguridad, handler)
    executor.ts      Puerta común: política → caso de uso → auditoría
    cli/             CLI, vistas, informes HTML/Markdown, autocompletado
    mcp/             Servidor MCP (tools, resources, prompts) y transporte HTTP
  main/            Composition root y puntos de entrada
```

### Extender

- **Nueva operación**: caso de uso → entrada en `presentation/catalog.ts` (+ vista opcional). Aparece en CLI, ayuda, autocompletado y MCP, y pasa por la misma política y auditoría.
- **Nuevo transporte** (MTP, root, agente en el dispositivo): implementa los puertos que soporte y cámbialo en `main/container.ts`.
- **Nuevas reglas**: umbrales y diagnósticos en `domain/`, probados sin dispositivo.

## Telegram

Telegram requiere una cuenta de usuario MTProto con `TELEGRAM_API_ID` y `TELEGRAM_API_HASH`; un token de bot no se guarda ni se usa para acceder a Mensajes guardados. El proveedor está definido (`BackupProvider`) pero aún no conectado a ningún caso de uso.

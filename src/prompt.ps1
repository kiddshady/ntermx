# ===============================================================
# ntermx — init de shell (UTF-8 + OSC 7)
# ===============================================================
# Lo dot-sourcea main.js al abrir la terminal, DESPUÉS de que pwsh cargó el
# perfil del usuario. Hace dos cosas: poner la consola en UTF-8 y emitir OSC 7
# (cwd actual) en cada prompt, para que la status bar de la app siga el
# directorio real en vez de quedar clavada en el de arranque.
#
# NO pisa el prompt del usuario: captura el vigente y lo ENVUELVE, así el
# core-profile de UMBROCORE-X (y su prompt) quedan intactos. Tampoco toca
# $PSStyle: los colores de salida los define el core-profile.
#
# IMPORTANTE — todo este archivo es StrictMode-safe. El core-profile corre
# `Set-StrictMode -Version Latest`, y bajo StrictMode LEER una variable que no
# existe es un ERROR, no $null. Esa era la causa del prompt roto: el guard
# `if (-not $Global:__NeonRgb)` explotaba, el bloque de colores nunca corría, y
# el prompt terminaba referenciando variables inexistentes -> PowerShell caía a
# su prompt de emergencia `PS>`. Para leer algo que puede no existir, usar
# `Test-Path variable:...`, nunca la variable pelada.
# ===============================================================

# Guard de re-entrada: si la terminal recarga el init, no volvemos a envolver el
# prompt (envolver dos veces emitiría OSC 7 duplicado en cada render).
if (Test-Path variable:global:__NeonInit) { return }
$global:__NeonInit = $true

# ---------------------------------------------------------------------------
# Consola en UTF-8
# ---------------------------------------------------------------------------
# La consola virtual que node-pty (ConPTY) le arma al shell nace con la code page
# OEM del sistema: en un Windows en español es la 850, no la 65001. Eso NO afecta
# a PowerShell —.NET escribe con WriteConsoleW, o sea wide chars, sin pasar por la
# code page— pero sí a cualquier exe nativo que tire bytes UTF-8 crudos a stdout:
# speedtest, las CLIs de Go/Rust, y el main de una app Electron (que al ser
# subsistema GUI no se detecta como TTY, así que Node emite bytes en vez de usar
# WriteConsoleW). ConPTY decodifica esos bytes como 850, y como en UTF-8 una
# acentuada son DOS bytes, salen DOS caracteres:
#
#     ó = C3 B3 -> '├' + '│'   →   "Córdoba" llega como "C├│rdoba"
#     ñ = C3 B1 -> '├' + '▒'   →   "Dueño"   llega como "Due├▒o"
#
# Cambiar la code page acá vale para TODOS los hijos, porque es una propiedad del
# host de consola, no del proceso. La entrada no hacía falta arreglarla (ConPTY
# siempre trata su pipe de entrada como UTF-8, tipear ñ nunca estuvo roto), pero
# la seteamos igual por simetría: el exe nativo que lea stdin como bytes espera
# UTF-8 del otro lado.
#
# El UTF8Encoding va con $false = sin BOM. Con [Text.Encoding]::UTF8 (que lo trae
# en true) PowerShell antepone EF BB BF al redirigir salida, y aparece un "" de
# la nada al principio del archivo.
#
# Corre después del perfil, así que un exe nativo llamado DESDE el perfil todavía
# saldría mojibake. Es el único hueco y es barato: para taparlo habría que meter un
# `cmd /c chcp 65001 &&` delante del pwsh, y eso deja un cmd.exe de padre que se
# come el kill() y deja pwsh huérfano al cerrar la tab. No vale el cambio.
try {
    $global:__NeonUtf8 = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $global:__NeonUtf8
    [Console]::InputEncoding  = $global:__NeonUtf8
    # Encoding que usa PowerShell al PIPEAR hacia un exe nativo (distinto de los de
    # arriba, que son los de la consola). Sin esto, `"ñ" | foo.exe` sale en 850.
    $global:OutputEncoding = $global:__NeonUtf8
} catch {
    # Si algún host raro no deja tocar la consola, seguimos: mejor mojibake que
    # un shell que no arranca.
}

# ---------------------------------------------------------------------------
# Prompt: envolvemos el vigente (el del core-profile, o el default de pwsh).
# ---------------------------------------------------------------------------
$global:__NeonInnerPrompt = $function:prompt

function global:prompt {
    # OSC 7 — sólo si estamos parados en el filesystem (no en HKLM:, Env:, etc.).
    try {
        $loc = $ExecutionContext.SessionState.Path.CurrentLocation
        if ($loc -and $loc.Provider.Name -eq 'FileSystem') {
            # Los espacios van como %20: el renderer corta la secuencia en el
            # primer espacio, así que un `C:\Program Files` sin escapar dejaría
            # la status bar mostrando "C:\Program".
            $uri = ($loc.ProviderPath -replace '\\', '/').Replace(' ', '%20')
            # ESC ] 7 ; file:///<path> BEL   (BEL = terminador; xterm lo consume)
            [Console]::Write([char]27 + ']7;file:///' + $uri + [char]7)
        }
    } catch { }

    # Devolvemos el prompt original tal cual (o el default si no hubiera).
    if ($global:__NeonInnerPrompt) { & $global:__NeonInnerPrompt }
    else { "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}

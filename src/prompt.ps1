# ===============================================================
# Konsol — init de shell (OSC 7)
# ===============================================================
# Lo dot-sourcea main.js al abrir la terminal, DESPUÉS de que pwsh cargó el
# perfil del usuario. Hace una sola cosa: emitir OSC 7 (cwd actual) en cada
# prompt, para que la status bar de la app siga el directorio real en vez de
# quedar clavada en el de arranque.
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

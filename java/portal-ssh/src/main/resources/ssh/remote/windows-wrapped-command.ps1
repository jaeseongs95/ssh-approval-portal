[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$global:LASTEXITCODE=0;try { & { @@PRELUDE@@@@COMMAND@@
} | Microsoft.PowerShell.Core\Out-Default;exit $LASTEXITCODE } catch { @@ERROR_REPORT@@exit 1 }

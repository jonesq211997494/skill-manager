[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PreviousInstaller,
    [string]$CurrentInstaller,
    [string]$PreviousVersion = '0.2.0',
    [string]$PreviousChecksums,
    [string]$CurrentChecksums
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 安装与卸载会写入真实注册表和快捷方式，只允许一次性托管 runner 执行。
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw '此测试只能在 GitHub 托管的 Windows runner 上执行，禁止在开发者现有账户中安装或卸载。'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersion = $package.version
if (-not $CurrentInstaller) { $CurrentInstaller = Join-Path $projectRoot "release\Skill-Manager-$currentVersion-setup-x64.exe" }
$CurrentInstaller = (Resolve-Path -LiteralPath $CurrentInstaller).Path
$PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstaller).Path
if ($CurrentInstaller -eq $PreviousInstaller -or [version]$PreviousVersion -ge [version]$currentVersion) {
    throw '升级验证必须提供版本较低的独立安装包。'
}
foreach ($installer in @($CurrentInstaller, $PreviousInstaller)) {
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "安装包不存在：$installer" }
}
if (-not $PreviousChecksums) { $PreviousChecksums = Join-Path (Split-Path -Parent $PreviousInstaller) "SHA256SUMS-$PreviousVersion.txt" }
if (-not $CurrentChecksums) { $CurrentChecksums = Join-Path (Split-Path -Parent $CurrentInstaller) "SHA256SUMS-$currentVersion.txt" }
function Assert-InstallerArtifact([string]$Installer, [string]$Version, [string]$Checksums) {
    $filename = [IO.Path]::GetFileName($Installer)
    $entries = @(Get-Content -LiteralPath $Checksums | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($filename) + '$') })
    if ($entries.Count -ne 1) { throw "校验清单缺少唯一安装包条目：$Checksums / $filename" }
    $expectedHash = ($entries[0] -split '\s+')[0]
    $actualHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "安装包 SHA-256 与清单不符：$Installer" }
    $versionInfo = (Get-Item -LiteralPath $Installer).VersionInfo
    if ($versionInfo.ProductVersion -ne $Version -or $versionInfo.FileVersion -ne $Version -or $versionInfo.ProductName -ne 'Skill Manager') {
        throw "安装包版本资源不正确：$Installer / $($versionInfo.ProductVersion)"
    }
    return @{ version = $Version; installer = $filename; sha256 = $actualHash; checksumManifest = [IO.Path]::GetFileName($Checksums);
        fileVersion = $versionInfo.FileVersion; productVersion = $versionInfo.ProductVersion; productName = $versionInfo.ProductName }
}
$previousArtifact = Assert-InstallerArtifact $PreviousInstaller $PreviousVersion $PreviousChecksums
$currentArtifact = Assert-InstallerArtifact $CurrentInstaller $currentVersion $CurrentChecksums
# 与 electron-builder 的真实 appId 对应，不更换测试专用应用身份。
if ($package.build.appId -ne 'local.skillmanager.desktop') { throw 'appId 已变化，需要更新生命周期测试的注册表定位。' }
$appGuid = 'fd2f013b-2c96-5c38-b2f5-a2b477ac7671'
$appDataRoot = [Environment]::GetFolderPath('ApplicationData')
$dataDirectory = Join-Path $appDataRoot 'SkillManagerDesktop'
$shortcutPaths = @(
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Skill Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Skill Manager.lnk')
)
$allShortcutPaths = $shortcutPaths + @(
    (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Skill Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Skill Manager.lnk')
)

function Get-ApplicationRegistry {
    $entries = @()
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $installKey = $base.OpenSubKey("Software\$appGuid")
                if ($null -ne $installKey) {
                    try { $entries += [pscustomobject]@{ Hive = "$hive"; Kind = 'install'; Key = "Software\$appGuid"; Location = $installKey.GetValue('InstallLocation', '') } }
                    finally { $installKey.Dispose() }
                }
                $uninstallRoot = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
                if ($null -ne $uninstallRoot) {
                    try {
                        foreach ($keyName in $uninstallRoot.GetSubKeyNames()) {
                            $key = $uninstallRoot.OpenSubKey($keyName)
                            try {
                                $displayName = [string]$key.GetValue('DisplayName', '')
                                if ($keyName -eq $appGuid -or $displayName -like 'Skill Manager*') {
                                    $entries += [pscustomobject]@{ Hive = "$hive"; Kind = 'uninstall'; Key = $keyName;
                                        DisplayName = $displayName; Version = [string]$key.GetValue('DisplayVersion', '');
                                        UninstallString = [string]$key.GetValue('UninstallString', '');
                                        QuietUninstallString = [string]$key.GetValue('QuietUninstallString', '') }
                                }
                            } finally { if ($null -ne $key) { $key.Dispose() } }
                        }
                    } finally { $uninstallRoot.Dispose() }
                }
            } finally { $base.Dispose() }
        }
    }
    # 部分 HKCU 键在 32/64 位视图共享，按真实键身份去重。
    $entries | Group-Object { "$($_.Hive)|$($_.Kind)|$($_.Key)" } | ForEach-Object { $_.Group[0] }
}

if (@(Get-ApplicationRegistry).Count -ne 0) { throw '发现既有 Skill Manager 注册信息，拒绝继续。' }
$existingPaths = $allShortcutPaths + @(
    $dataDirectory,
    (Join-Path $appDataRoot 'Skill Manager'),
    (Join-Path $appDataRoot 'skill-manager-desktop'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Skill Manager'),
    (Join-Path $env:ProgramFiles 'Skill Manager')
)
foreach ($existingPath in $existingPaths) {
    if (Test-Path -LiteralPath $existingPath) { throw "发现既有安装或用户数据，拒绝继续：$existingPath" }
}
if (@(Get-Process -Name 'Skill Manager' -ErrorAction SilentlyContinue).Count -gt 0) { throw '发现正在运行的 Skill Manager，拒绝继续。' }

$runRoot = Join-Path ([IO.Path]::GetTempPath()) ('skill-manager-lifecycle-' + [guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $runRoot 'Skill Manager'
$installedExe = Join-Path $installDirectory 'Skill Manager.exe'
$installedUninstaller = Join-Path $installDirectory 'Uninstall Skill Manager.exe'
$homeDirectory = Join-Path $runRoot 'home'
$resultsDirectory = Join-Path $projectRoot 'test-results'
New-Item -ItemType Directory -Path $runRoot, $resultsDirectory -Force | Out-Null
$evidence = [ordered]@{
    status = 'running'; checkedAt = [DateTime]::UtcNow.ToString('o'); runner = $env:RUNNER_ENVIRONMENT;
    os = [Environment]::OSVersion.VersionString; installDirectory = $installDirectory; dataDirectory = $dataDirectory;
    current = $currentArtifact;
    previous = $previousArtifact;
    stages = @()
}

function Add-Stage([string]$Name, $Details) {
    $evidence.stages += [ordered]@{ name = $Name; status = 'passed'; checkedAt = [DateTime]::UtcNow.ToString('o'); details = $Details }
    Write-Host "通过：$Name"
}

function Invoke-InstallerProcess([string]$FilePath, [string]$Arguments) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $runRoot -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(180000)) {
        # 仅终止此次启动的安装程序树，防止超时后继续写入。
        & taskkill /PID $process.Id /T /F | Out-Null
        throw "安装程序超时：$FilePath"
    }
    if ($process.ExitCode -ne 0) { throw "安装程序返回错误 $($process.ExitCode)：$FilePath" }
}

function Assert-Installed([string]$Version) {
    foreach ($file in @($installedExe, $installedUninstaller, (Join-Path $installDirectory 'resources\app.asar'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "安装文件缺失：$file" }
    }
    $entries = @(Get-ApplicationRegistry)
    $installEntries = @($entries | Where-Object { $_.Kind -eq 'install' -and $_.Hive -eq 'CurrentUser' })
    $uninstallEntries = @($entries | Where-Object { $_.Kind -eq 'uninstall' -and $_.Hive -eq 'CurrentUser' })
    if ($entries.Count -ne 2 -or $installEntries.Count -ne 1 -or $uninstallEntries.Count -ne 1) { throw '安装注册表条目数量或用户范围不正确。' }
    if ($installEntries[0].Location -ne $installDirectory -or $uninstallEntries[0].Version -ne $Version) { throw '安装目录或卸载注册表版本不正确。' }
    if ($uninstallEntries[0].UninstallString -ne ('"' + $installedUninstaller + '" /currentuser') -or
        $uninstallEntries[0].QuietUninstallString -ne ('"' + $installedUninstaller + '" /currentuser /S')) { throw '卸载命令注册信息不正确。' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcuts = @()
    try {
        foreach ($shortcutPath in $shortcutPaths) {
            if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) { throw "快捷方式缺失：$shortcutPath" }
            $shortcut = $shell.CreateShortcut($shortcutPath)
            try {
                if ($shortcut.TargetPath -ne $installedExe) { throw "快捷方式目标不正确：$shortcutPath" }
                $shortcuts += @{ path = $shortcutPath; target = $shortcut.TargetPath }
            } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null }
        }
    } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
    return @{ registry = $entries; shortcuts = $shortcuts }
}

function New-OwnedData {
    if (Test-Path -LiteralPath $dataDirectory) { throw '创建测试数据前发现目录已存在。' }
    New-Item -ItemType Directory -Path $dataDirectory | Out-Null
    [IO.File]::WriteAllText((Join-Path $dataDirectory '.installer-lifecycle-owner'), $runRoot)
}

function Invoke-AppSmoke([string]$Version, [string]$Phase, [bool]$Seed, [string]$ReportName) {
    $output = Join-Path $resultsDirectory $ReportName
    $nodeArgs = @((Join-Path $PSScriptRoot 'installed-app-smoke.mjs'), '--exe', $installedExe, '--version', $Version,
        '--home', $homeDirectory, '--data-dir', $dataDirectory, '--owner', $runRoot, '--phase', $Phase, '--output', $output)
    if ($Seed) { $nodeArgs += '--seed' }
    & node @nodeArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "安装版启动与数据验证失败：$Phase" }
    return (Get-Content -LiteralPath $output -Raw | ConvertFrom-Json)
}

function Assert-Preserved($Report) {
    foreach ($file in $Report.preservedFiles) {
        if (-not (Test-Path -LiteralPath $file.path -PathType Leaf)) { throw "卸载后用户数据丢失：$($file.path)" }
        if ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -ne $file.sha256) { throw "卸载后用户数据内容变化：$($file.path)" }
    }
}

function Uninstall-TestApplication {
    # 复制真实卸载器到目录外；_?= 放末尾且不加引号，可等待实际卸载进程并允许删除原卸载器。
    $uninstallerCopy = Join-Path $runRoot ('uninstaller-' + [guid]::NewGuid().ToString('N') + '.exe')
    Copy-Item -LiteralPath $installedUninstaller -Destination $uninstallerCopy
    Invoke-InstallerProcess $uninstallerCopy "/S /currentuser _?=$installDirectory"
    if (Test-Path -LiteralPath $installDirectory) { throw '卸载后安装目录仍存在。' }
    if (@(Get-ApplicationRegistry).Count -ne 0) { throw '卸载后注册表信息仍存在。' }
    foreach ($shortcutPath in $allShortcutPaths) {
        if (Test-Path -LiteralPath $shortcutPath) { throw "卸载后快捷方式仍存在：$shortcutPath" }
    }
}

try {
    # /D 必须是最后一项，NSIS 直接读取其后的完整目录，不能给路径添加引号。
    Invoke-InstallerProcess $CurrentInstaller "/S /currentuser /D=$installDirectory"
    Add-Stage 'clean-install' (Assert-Installed $currentVersion)
    New-OwnedData
    $fresh = Invoke-AppSmoke $currentVersion 'fresh' $true 'installed-current.json'
    Add-Stage 'installed-app-launch' $fresh
    Uninstall-TestApplication
    Assert-Preserved $fresh
    Add-Stage 'uninstall-preserves-data' @{ files = $fresh.preservedFiles; registryRemoved = $true; shortcutsRemoved = $true; installDirectoryRemoved = $true }

    # 只删除本次创建的数据；先校验绝对路径和所有权，给旧版本提供真正的首次运行环境。
    $resolvedData = (Resolve-Path -LiteralPath $dataDirectory).Path
    $expectedData = [IO.Path]::GetFullPath((Join-Path $appDataRoot 'SkillManagerDesktop'))
    if ($resolvedData -ne $expectedData -or (Get-Content -LiteralPath (Join-Path $resolvedData '.installer-lifecycle-owner') -Raw) -ne $runRoot) {
        throw '数据清理路径或所有权校验失败。'
    }
    Remove-Item -LiteralPath $resolvedData -Recurse -Force
    Invoke-InstallerProcess $PreviousInstaller "/S /currentuser /D=$installDirectory"
    Add-Stage 'previous-install' (Assert-Installed $PreviousVersion)
    New-OwnedData
    $previous = Invoke-AppSmoke $PreviousVersion 'upgrade' $true 'installed-previous.json'
    Add-Stage 'previous-app-data-created' $previous
    Invoke-InstallerProcess $CurrentInstaller "/S /currentuser /D=$installDirectory"
    Add-Stage 'upgrade-install' (Assert-Installed $currentVersion)
    # 升级不能依赖新版本重新造数据；仅检查旧版本创建的设置、登记、技能和备份。
    $upgraded = Invoke-AppSmoke $currentVersion 'upgrade' $false 'installed-upgraded.json'
    Add-Stage 'upgrade-preserves-usable-data' $upgraded
    Uninstall-TestApplication
    Assert-Preserved $upgraded
    Add-Stage 'upgraded-uninstall-preserves-data' @{ files = $upgraded.preservedFiles; registryRemoved = $true; shortcutsRemoved = $true; installDirectoryRemoved = $true }
    $evidence.status = 'passed'
} catch {
    $evidence.status = 'failed'
    $evidence.error = $_.Exception.Message
    throw
} finally {
    # 失败时保留一次性 runner 上的现场与结果，由 GitHub Actions 回收机器。
    $evidence.finishedAt = [DateTime]::UtcNow.ToString('o')
    $evidence | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $resultsDirectory 'installer-lifecycle.json') -Encoding utf8
}

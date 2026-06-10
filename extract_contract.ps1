Add-Type -AssemblyName System.IO.Compression.FileSystem

function Extract-DocxParagraphs($docxPath) {
    $temp = Join-Path $env:TEMP ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    try {
        [System.IO.Compression.ZipFile]::ExtractToDirectory($docxPath, $temp)
        $xml = [System.IO.File]::ReadAllText((Join-Path $temp "word\document.xml"), [System.Text.Encoding]::UTF8)
        $chunks = $xml -split '</w:p>'
        $lines = New-Object System.Collections.Generic.List[string]
        foreach ($chunk in $chunks) {
            $matches = [regex]::Matches($chunk, '<w:t[^>]*>([^<]*)</w:t>')
            if ($matches.Count -eq 0) { continue }
            $text = ($matches | ForEach-Object { $_.Groups[1].Value }) -join ''
            $text = $text.Trim()
            if ($text.Length -gt 0) { $lines.Add($text) }
        }
        return ($lines -join "`n`n")
    }
    finally {
        Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$root = Split-Path $PSScriptRoot -Parent
$docxFiles = Get-ChildItem -Path $root -Filter "*.docx" -File
$contractAr = $docxFiles | Where-Object { $_.Name -like "*(2).docx" } | Select-Object -First 1
$contractEn = $docxFiles | Where-Object { $_.Name -like "*(1).docx" } | Select-Object -First 1

if ($contractAr) {
    $text = Extract-DocxParagraphs $contractAr.FullName
    [System.IO.File]::WriteAllText((Join-Path $root "contract_ar_v2.txt"), $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "AR contract: $($text.Length) chars"
}

if ($contractEn) {
    $text = Extract-DocxParagraphs $contractEn.FullName
    [System.IO.File]::WriteAllText((Join-Path $root "contract_en_v2.txt"), $text, [System.Text.UTF8Encoding]::new($false))
    Write-Host "EN contract: $($text.Length) chars"
}

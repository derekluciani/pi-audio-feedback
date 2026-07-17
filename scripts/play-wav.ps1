param([Parameter(Mandatory = $true)][string]$Path)
$player = [System.Media.SoundPlayer]::new($Path)
$player.Load()
$player.PlaySync()

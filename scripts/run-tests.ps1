$ErrorActionPreference = "Stop"

Write-Host "== Synthetiq V4 Host smoke test =="

node src/cli.mjs list

Write-Host "`n== AnimeKai search =="
node src/cli.mjs search AnimeKai "One Piece"

Write-Host "`nIf the upstream service is reachable, the JSON above confirms that"
Write-Host "the original module executed through the reconstructed host runtime."

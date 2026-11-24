<#
  The local test environment for Deploy King, in one place.

    .\tests\local\env.ps1 up         build the image if needed, create the containers, set everything up
    .\tests\local\env.ps1 test       run every check (or: test capacity.mjs  to run one)
    .\tests\local\env.ps1 status     what is running
    .\tests\local\env.ps1 sync       copy the repository into the container and restart API and worker
    .\tests\local\env.ps1 panel      rebuild and restart the panel
    .\tests\local\env.ps1 migrate    generate the next database migration and copy it back into the repository
    .\tests\local\env.ps1 sh         a shell inside the container
    .\tests\local\env.ps1 down       stop and remove the containers (the image and the working copy are kept)

  Needs Podman with a running machine. Everything it creates is named dbbkp-check-*.
  Panel: http://localhost:3900   API: http://localhost:4000   deployed apps: http://<name>.localhost:8088
#>
param([Parameter(Position = 0)][string]$Command = "status", [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = "Continue"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Net = "dbbkp-check-net"
$App = "dbbkp-check-app"
$Image = "localhost/dbbkp-check-app:tools"
$All = @("dbbkp-check-app", "dbbkp-check-traefik", "dbbkp-check-redis", "dbbkp-check-pg")

function Exists($kind, $name) { podman $kind exists $name 2>$null; return $LASTEXITCODE -eq 0 }
function InApp([string]$script) { podman exec $App bash -c $script }

switch ($Command) {
  "up" {
    podman ps -q *> $null
    if ($LASTEXITCODE -ne 0) { throw "Podman is not reachable. Start it first: podman machine start" }
    # The API, the worker and Traefik talk to the container engine through its socket.
    $rootful = (podman machine inspect --format "{{.Rootful}}" 2>$null) -eq "true"
    $sock = if ($rootful) { "/run/podman/podman.sock" } else { "/run/user/1000/podman/podman.sock" }

    if (-not (Exists network $Net)) { podman network create $Net | Out-Null }
    foreach ($v in "dbbkp-check-work", "dbbkp-check-sites") { if (-not (Exists volume $v)) { podman volume create $v | Out-Null } }
    if (-not (Exists image $Image)) {
      Write-Host "== building the tools image (a few minutes the first time)"
      podman build -t $Image -f (Join-Path $PSScriptRoot "env\Containerfile") (Join-Path $PSScriptRoot "env")
      if ($LASTEXITCODE -ne 0) { throw "The image did not build." }
    }
    if (-not (Exists container dbbkp-check-pg)) { podman run -d --name dbbkp-check-pg --network $Net -e POSTGRES_PASSWORD=postgres docker.io/library/postgres:15-alpine | Out-Null }
    if (-not (Exists container dbbkp-check-redis)) { podman run -d --name dbbkp-check-redis --network $Net docker.io/library/redis:7-alpine | Out-Null }
    if (-not (Exists container dbbkp-check-traefik)) {
      podman run -d --name dbbkp-check-traefik --network $Net -p 8088:80 --security-opt label=disable -v "${sock}:/var/run/docker.sock:ro" docker.io/library/traefik:v3 `
        --providers.docker=true --providers.docker.exposedbydefault=false --providers.docker.network=$Net --entrypoints.web.address=:80 | Out-Null
    }
    if (-not (Exists container $App)) {
      podman run -d --name $App --network $Net -p 3900:3000 -p 4000:4000 --security-opt label=disable `
        -v "${Repo}:/src:ro" -v dbbkp-check-work:/work -v dbbkp-check-sites:/var/www/sites -v "${sock}:/var/run/docker.sock" $Image | Out-Null
    }
    $started = podman start @All 2>&1
    if ((podman inspect -f "{{.State.Running}}" $App 2>$null) -ne "true") {
      Write-Host "The containers did not start. Podman said:" -ForegroundColor Red
      $started | ForEach-Object { Write-Host "  $_" }
      Write-Host "Check that Podman can run anything at all:  podman run --rm docker.io/library/redis:7-alpine redis-server --version"
      exit 1
    }
    InApp "bash /src/tests/local/env/setup.sh"
  }
  "test" {
    if ($Rest) { InApp "bash /src/tests/local/env/pull.sh > /dev/null; cd /tmp/shot && node /t/$($Rest -join ' ')" }
    else { InApp "bash /src/tests/local/env/pull.sh > /dev/null; bash /t/all.sh 2>&1 | tee /tmp/all.log" }
  }
  "status" {
    podman ps -a --filter "name=dbbkp-check" --format "{{.Names}}  {{.Status}}"
    InApp "curl -s -m 3 -o /dev/null -w 'api %{http_code}  ' http://localhost:4000/health; curl -s -m 3 -o /dev/null -w 'panel %{http_code}\n' http://localhost:3000/login"
  }
  "sync" { InApp "bash /src/tests/local/env/pull.sh > /dev/null; bash /t/sync.sh; bash /t/tc.sh 20; bash /t/start.sh > /dev/null 2>&1; curl -s -m 5 -o /dev/null -w 'api %{http_code}\n' http://localhost:4000/health" }
  "panel" { InApp "bash /src/tests/local/env/pull.sh > /dev/null; bash /t/sync.sh; bash /t/ptc.sh 20; bash /t/panel.sh" }
  "migrate" {
    InApp "bash /src/tests/local/env/pull.sh > /dev/null; bash /t/gen.sh"
    podman cp "${App}:/work/packages/db/drizzle/." (Join-Path $Repo "packages\db\drizzle")
    Write-Host "migration files copied to packages\db\drizzle"
  }
  "sh" { podman exec -it $App bash }
  "down" { podman rm -f @All | Out-Null; Write-Host "containers removed; image, working copy and network kept" }
  default { Get-Help $PSCommandPath }
}

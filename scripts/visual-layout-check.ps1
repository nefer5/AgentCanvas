param(
    [string]$Url = 'http://127.0.0.1:4173'
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$agentBrowser = (Get-Command agent-browser -ErrorAction Stop).Source
$collapseButtonName = ([string][char]0x6536) + ([char]0x8D77)
$expandButtonName = ([string][char]0x5C55) + ([char]0x5F00)

function Invoke-AgentBrowser([string]$Session, [string[]]$Arguments) {
    & $agentBrowser --session $Session @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "agent-browser failed ($LASTEXITCODE): $($Arguments -join ' ')"
    }
}

function Close-AgentBrowserSession(
    [string]$Session,
    [ref]$Failure
) {
    $Failure.Value = $null
    try {
        Invoke-AgentBrowser $Session @('close')
    }
    catch {
        $Failure.Value = $_
    }
}

function Assert-RenderedLayout(
    [string]$Session,
    [string]$Scheme,
    [bool]$Expanded,
    [string]$State
) {
    $script = @'
(() => {
  const scheme = '__SCHEME__';
  const state = '__STATE__';
  const expectedDark = __EXPECTED_DARK__;
  const expectedExpanded = __EXPECTED_EXPANDED__;
  const panel = document.querySelector('.agent-panel');
  const toolbar = document.querySelector('.App-toolbar');
  const collapse = document.querySelector('.agent-panel__collapse');
  if (!panel || !toolbar || !collapse) throw new Error('Required layout nodes are missing');
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  };
  const metrics = {
    viewport: { width: innerWidth, height: innerHeight },
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    expanded: collapse.getAttribute('aria-expanded') === 'true',
    panel: rect(panel),
    toolbar: rect(toolbar),
  };
  const metricStore = globalThis.__excalidrawVisualLayoutMetrics ??= {};
  let savedMetrics;
  if (state === 'expanded-initial') {
    savedMetrics = { initial: metrics };
    metricStore[scheme] = savedMetrics;
  } else {
    savedMetrics = metricStore[scheme] ?? {};
  }
  const intersects = metrics.panel.left < metrics.toolbar.right
    && metrics.panel.right > metrics.toolbar.left
    && metrics.panel.top < metrics.toolbar.bottom
    && metrics.panel.bottom > metrics.toolbar.top;
  const violations = [];
  if (metrics.viewport.width !== 390 || metrics.viewport.height !== 844) {
    violations.push(`expected viewport 390x844, got ${metrics.viewport.width}x${metrics.viewport.height}`);
  }
  if (metrics.dark !== expectedDark) violations.push(`expected dark=${expectedDark}`);
  if (metrics.expanded !== expectedExpanded) violations.push(`expected expanded=${expectedExpanded}`);
  if (metrics.panel.width <= 0 || metrics.panel.height <= 0
    || metrics.toolbar.width <= 0 || metrics.toolbar.height <= 0) {
    violations.push('panel or toolbar has an empty rendered box');
  }
  if (intersects) violations.push('Agent panel intersects the Excalidraw toolbar');
  if (metrics.panel.left < 0 || metrics.panel.right > metrics.viewport.width
    || metrics.panel.top < 0 || metrics.panel.bottom > metrics.viewport.height) {
    violations.push(`Agent panel extends outside the viewport: left=${metrics.panel.left}, right=${metrics.panel.right}, top=${metrics.panel.top}, bottom=${metrics.panel.bottom}`);
  }
  let stateComparison = null;
  if (state === 'collapsed') {
    const initial = savedMetrics.initial;
    savedMetrics.collapsed = metrics;
    if (!initial) {
      violations.push('Initial expanded metrics were not saved before collapse');
    } else {
      const initialArea = initial.panel.width * initial.panel.height;
      const collapsedArea = metrics.panel.width * metrics.panel.height;
      const heightReduction = initial.panel.height - metrics.panel.height;
      const areaRatio = collapsedArea / initialArea;
      stateComparison = { heightReduction, areaRatio };
      if (heightReduction < 16 && areaRatio > 0.8) {
        violations.push(`Collapsed panel did not shrink significantly: heightReduction=${heightReduction}, areaRatio=${areaRatio}`);
      }
    }
  } else if (state === 'expanded-restored') {
    const initial = savedMetrics.initial;
    savedMetrics.restored = metrics;
    if (!initial) violations.push('Initial expanded metrics were not saved before restore');
    if (!savedMetrics.collapsed) violations.push('Collapsed metrics were not saved before restore');
    if (initial) {
      const boxKeys = ['left', 'top', 'right', 'bottom', 'width', 'height'];
      const deltas = {};
      for (const target of ['panel', 'toolbar']) {
        deltas[target] = Object.fromEntries(boxKeys.map((key) => [
          key,
          Math.abs(metrics[target][key] - initial[target][key]),
        ]));
      }
      const maxDelta = Math.max(...Object.values(deltas).flatMap((box) => Object.values(box)));
      stateComparison = { tolerance: 1, maxDelta, deltas };
      if (maxDelta > 1) {
        violations.push(`Restored boxes differ from initial metrics by ${maxDelta}px (tolerance 1px)`);
      }
    }
  }
  const evidence = {
    scheme,
    state,
    intersects,
    savedStates: Object.keys(savedMetrics),
    stateComparison,
    ...metrics,
  };
  if (violations.length > 0) {
    throw new Error(`${scheme}/${state}: ${violations.join('; ')}; metrics=${JSON.stringify(evidence)}`);
  }
  return JSON.stringify(evidence);
})()
'@
    $script = $script.Replace('__SCHEME__', $Scheme)
    $script = $script.Replace('__STATE__', $State)
    $script = $script.Replace('__EXPECTED_DARK__', $(if ($Scheme -eq 'dark') { 'true' } else { 'false' }))
    $script = $script.Replace('__EXPECTED_EXPANDED__', $(if ($Expanded) { 'true' } else { 'false' }))
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
    Invoke-AgentBrowser $Session @('eval', '-b', $encoded)
}

try {
    $health = Invoke-RestMethod -Uri "$Url/api/health" -Method Get -TimeoutSec 2
    if ($null -eq $health -or -not (($health.ok -is [bool]) -and $health.ok)) {
        throw "A compatible Excalidraw Local server is not healthy at $Url"
    }

    foreach ($scheme in @('light', 'dark')) {
        $session = "excalidraw-visual-$scheme-$PID"
        $primaryFailure = $null
        $closeFailure = $null
        try {
            Invoke-AgentBrowser $session @('--color-scheme', $scheme, 'open', $Url)
            Invoke-AgentBrowser $session @('set', 'viewport', '390', '844')
            Invoke-AgentBrowser $session @('wait', '--load', 'networkidle')
            Invoke-AgentBrowser $session @('wait', '200')

            Assert-RenderedLayout $session $scheme $true 'expanded-initial'
            Invoke-AgentBrowser $session @('find', 'role', 'button', 'click', '--name', $collapseButtonName)
            Assert-RenderedLayout $session $scheme $false 'collapsed'
            Invoke-AgentBrowser $session @('find', 'role', 'button', 'click', '--name', $expandButtonName)
            Assert-RenderedLayout $session $scheme $true 'expanded-restored'
        }
        catch {
            $primaryFailure = $_
        }
        finally {
            Close-AgentBrowserSession $session ([ref]$closeFailure)
        }

        if ($null -ne $primaryFailure) {
            if ($null -ne $closeFailure) {
                Write-Warning "agent-browser session cleanup also failed: $($closeFailure.Exception.Message)"
            }
            throw $primaryFailure
        }
        if ($null -ne $closeFailure) {
            throw $closeFailure
        }
    }

    Write-Output 'Visual layout check passed (6 rendered states).'
}
catch {
    Write-Error $_
    exit 1
}

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

const FOLDER_PICKER_PROGRAM = [
  'Add-Type -AssemblyName System.Windows.Forms',
  "Add-Type -Name NativeWindow -Namespace AgentCanvas -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern System.IntPtr GetLastActivePopup(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr hWnd); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);'",
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.ShowInTaskbar = $false',
  '$owner.TopMost = $true',
  '$owner.Opacity = 0',
  '$owner.Show()',
  '$owner.Activate()',
  '$promoteTimer = New-Object System.Windows.Forms.Timer',
  '$promoteTimer.Interval = 100',
  '$promoteTimer.Add_Tick({',
  '  $popup = [AgentCanvas.NativeWindow]::GetLastActivePopup($owner.Handle)',
  '  if ($popup -ne [IntPtr]::Zero -and $popup -ne $owner.Handle) {',
  '    [void][AgentCanvas.NativeWindow]::SetWindowPos($popup, [IntPtr](-1), 0, 0, 0, 0, 0x0043)',
  '    [void][AgentCanvas.NativeWindow]::SetForegroundWindow($popup)',
  '    $promoteTimer.Stop()',
  '  }',
  '})',
  '$promoteTimer.Start()',
  '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$dialog.Description = '选择 Agent Canvas 项目目录'",
  '$dialog.ShowNewFolderButton = $true',
  'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
  '  [Console]::Out.Write($dialog.SelectedPath)',
  '}',
  '$promoteTimer.Stop()',
  '$promoteTimer.Dispose()',
  '$owner.Close()',
  '$owner.Dispose()',
].join('\n')

export async function selectWindowsFolder({ execFileImpl = execFile } = {}) {
  const stdout = await new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', FOLDER_PICKER_PROGRAM],
      { encoding: 'utf8', windowsHide: false },
      (error, output) => {
        if (error) {
          reject(error)
          return
        }
        resolve(output)
      },
    )
  })
  const selectedPath = String(stdout ?? '').trim()
  if (!selectedPath) return null
  if (!win32.isAbsolute(selectedPath)) {
    throw new TypeError('Folder picker returned a non-absolute path')
  }
  return selectedPath
}

// electron-builder afterSign hook: with no Developer ID, ad-hoc sign the whole bundle so Apple Silicon
// Macs do not report the app as damaged. Real signing/notarization takes over when CSC_LINK/APPLE_ID exist.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log('  • ad-hoc signing (no Developer ID)', appPath)
  // --deep is deprecated by Apple and must NOT be used alongside a real Developer ID
  // (it re-signs the Electron Framework's nested bundles and invalidates them). Here it
  // is required: this branch only runs when there is no identity at all, so nothing has
  // signed the nested helpers, and an outer-only signature fails --verify --deep --strict
  // with "code has no resources but signature indicates they must be present".
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
}

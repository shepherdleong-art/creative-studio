import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => accessSync(path, constants.F_OK);
const executable = (path) => accessSync(path, constants.X_OK);

exists('installer/macos/Info.plist');
exists('installer/macos/launcher.c');
exists('installer/macos/launcher.sh');
exists('scripts/generate-icns.sh');
exists('scripts/generate-dmg-background.mjs');
exists('scripts/build-mac-installer.sh');
exists('MACOS.md');

executable('scripts/generate-icns.sh');
executable('scripts/build-mac-installer.sh');

const plist = read('installer/macos/Info.plist');
assert.match(plist, /<key>CFBundleName<\/key>\s*<string>产品素材工作台<\/string>/);
assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>com\.creativestudio\.workbench<\/string>/);
assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>CreativeStudio<\/string>/);
assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>app\.icns<\/string>/);
assert.match(plist, /<key>NSPrincipalClass<\/key>\s*<string>AtomApplication<\/string>/);
assert.match(plist, /<string>__VERSION__<\/string>/);

const launcher = read('installer/macos/launcher.sh');
assert.match(launcher, /DATA_ROOT="\$\{CREATIVE_STUDIO_DATA_ROOT:-\$HOME\/Library\/Application Support\/CreativeStudio\}"/);
assert.match(launcher, /runtime\/bin\/node/);
assert.match(launcher, /CREATIVE_STUDIO_DATA_ROOT="\$DATA_ROOT"/);
assert.match(launcher, /CREATIVE_STUDIO_DESKTOP="1"/);
assert.match(launcher, /curl -fsS -o \/dev\/null --max-time 2 "\$URL"/);
assert.match(launcher, /nohup "\$NODE_BIN" "\$SERVER"/);
assert.match(launcher, /open "\$URL"/);

const launcherC = read('installer/macos/launcher.c');
assert.match(launcherC, /\.\.\/Resources\/launcher\.sh/);
assert.match(launcherC, /execv\("\/bin\/bash"/);

const icns = read('scripts/generate-icns.sh');
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  assert.match(icns, new RegExp(`app-icon-${size}\\.png`));
}
assert.match(icns, /iconutil -c icns/);
assert.match(icns, /writing ICNS container directly/);
assert.match(icns, /chunk\.writeUInt32BE/);

const build = read('scripts/build-mac-installer.sh');
const desktopService = read('desktop/service.ts');
assert.match(build, /NODE_VERSION=22\.22\.3/);
assert.match(build, /ARCH=darwin-arm64/);
assert.match(build, /HOST_PLATFORM="\$\(node -p "process\.platform"\)"/);
assert.match(build, /HOST_ARCH="\$\(node -p "process\.arch"\)"/);
assert.match(build, /\[ "\$HOST_PLATFORM" != "darwin" \]/);
assert.match(build, /\[ "\$HOST_ARCH" != "arm64" \]/);
assert.match(build, /NODE_NAME="node-v\$NODE_VERSION-\$ARCH"/);
assert.match(build, /NODE_URL="https:\/\/nodejs\.org\/dist\/v\$NODE_VERSION\/\$NODE_NAME\.tar\.gz"/);
assert.match(build, /npm ci/);
assert.match(build, /npm run build/);
assert.match(build, /npm run build:desktop/);
assert.match(build, /npm run icons/);
assert.match(build, /ELECTRON_APP="\$ROOT\/node_modules\/electron\/dist\/Electron\.app"/);
assert.match(build, /copy_dir_contents "\$ELECTRON_APP" "\$APP"/);
assert.match(build, /mv "\$APP\/Contents\/MacOS\/Electron" "\$APP\/Contents\/MacOS\/CreativeStudio"/);
assert.match(build, /copy_dir_contents "\.next\/standalone" "\$STANDALONE_PAYLOAD"/);
assert.match(build, /copy_dir_contents "dist-desktop" "\$PAYLOAD\/dist-desktop"/);
assert.match(build, /main:'dist-desktop\/main\.js'/);
assert.match(desktopService, /CREATIVE_STUDIO_DESKTOP: '1'/);
assert.match(build, /for command in [^\n]*\blipo\b/);
assert.match(build, /binary_has_arch/);
assert.match(build, /binary_has_arch "\$BUNDLED_FFMPEG" arm64/);
assert.match(build, /if ! "\$BUNDLED_FFMPEG" -version/);
assert.match(build, /! binary_has_arch "\$BUNDLED_FFPROBE" arm64/);
assert.match(build, /rm -f "\$BUNDLED_FFPROBE"/);
assert.match(build, /BUNDLED_NODE="\$PAYLOAD\/runtime\/bin\/node"/);
assert.match(build, /dist-desktop.*-name '\*\.map'/s);
assert.match(build, /MAC_SIGNING_IDENTITY/);
assert.match(build, /MAC_NOTARY_PROFILE/);
assert.match(build, /--allow-adhoc/);
assert.match(build, /Release packaging requires a Developer ID signing identity/);
assert.match(build, /notarytool submit/);
assert.match(build, /notarized and is for local testing only/);
assert.doesNotMatch(build, /installer\/macos\/launcher\.(?:c|sh)|Contents\/Resources\/launcher\.sh/);
assert.match(build, /hdiutil create/);
assert.match(build, /generate-dmg-background\.mjs/);
assert.match(build, /osascript/);
assert.match(build, /set background picture/);
assert.match(build, /set icon size of viewOptions to 96/);
assert.match(build, /hdiutil convert/);
for (const forbidden of ['data', 'storage', 'outputs', 'docs', 'scripts', 'installer', '.git', 'desktop', '.env.local', '.venv-litellm', 'config.yaml', 'litellm-config.yaml']) {
  assert.match(build, new RegExp(forbidden.replace('.', '\\.')));
}

const dmgBackground = read('scripts/generate-dmg-background.mjs');
assert.match(dmgBackground, /安装产品素材工作台/);
assert.match(dmgBackground, /Applications/);
assert.match(dmgBackground, /sharp/);

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.scripts['build:mac-installer'], 'bash scripts/build-mac-installer.sh');

const macos = read('MACOS.md');
assert.match(macos, /npm run build:mac-installer/);
assert.match(macos, /产品素材工作台-\<version\>\.dmg/);
assert.match(macos, /xattr -dr com\.apple\.quarantine/);
assert.match(macos, /Library\/Application Support\/CreativeStudio/);
assert.match(macos, /退出 Creative Studio/);

const readme = read('README.md');
assert.match(readme, /## macOS 安装包/);
assert.match(readme, /\[MACOS\.md\]\(\.\/MACOS\.md\)/);
assert.match(readme, /npm run build:mac-installer/);

assert.equal(extname('dist/macos/产品素材工作台-0.3.0.dmg'), '.dmg');

console.log('macos-installer tests passed');

// @vitest-environment node
/** Workflows: no input or event text is pasted into a shell script, third-party actions are pinned, the build cannot write. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const DIR = '.github/workflows';
const files = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8');

/** The lines of every `run:` script (single-line and block form). */
function runLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && !/^[|>]/.test(m[2])) { out.push(m[2]); continue; }
    const indent = m[1].length;
    for (i++; i < lines.length && (!lines[i].trim() || lines[i].search(/\S/) > indent); i++) out.push(lines[i]);
    i--;
  }
  return out;
}

describe('workflows', () => {
  it('there are three, and each defaults to read-only access', () => {
    expect(files.sort()).toEqual(['android-build.yml', 'android.yml', 'release.yml']);
    for (const f of files) expect(read(f), f).toMatch(/^permissions:\n  contents: read$/m);
  });

  it('no ${{ … }} expression inside a shell script (inputs and event fields arrive as environment variables)', () => {
    for (const f of files) {
      const bad = runLines(read(f)).filter((l) => l.includes('${{'));
      expect(bad, f).toEqual([]);
    }
  });

  it('the manual tag is validated before anything is built', () => {
    const plan = read('release.yml').split('id: plan')[1].split('- run: npm ci')[0];
    expect(plan).toContain('TAG_INPUT: ${{ inputs.tag }}');
    expect(plan).toMatch(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/);
    expect(plan).toMatch(/does not match the version in package\.json/);
    expect(plan).toMatch(/already exists/);
  });

  it('third-party actions are pinned to a commit', () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/uses:\s*(\S+)/g)) {
        const ref = m[1];
        if (ref.startsWith('./') || ref.startsWith('actions/')) continue;
        expect(ref, `${f}: ${ref}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('checkouts do not leave the token behind, and only the publishing jobs can write', () => {
    for (const f of files) {
      const text = read(f);
      const checkouts = [...text.matchAll(/uses: actions\/checkout@\S+\n(\s+with:\n\s+persist-credentials: false)?/g)];
      for (const c of checkouts) expect(c[1], f).toBeTruthy();
    }
    expect(read('android-build.yml')).not.toMatch(/contents: write/);
    const writers = (f: string) => [...read(f).matchAll(/^  (\w+):\n(?:(?!^  \w+:\n)[\s\S])*?contents: write/gm)].map((m) => m[1]);
    expect(writers('android.yml')).toEqual(['prerelease']);
    expect(writers('release.yml')).toEqual(['publish']);
  });

  it('the checks run before any release job, and the release key can be made mandatory', () => {
    const rel = read('release.yml');
    const web = rel.split('\n  desktop:')[0];
    for (const step of ['npm run typecheck', 'npm test', 'npm run e2e']) expect(web).toContain(step);
    for (const job of ['desktop', 'ios', 'android']) expect(rel.split(`\n  ${job}:`)[1].split('\n\n')[0]).toMatch(/needs: web/);
    expect(rel).toMatch(/require_release_key: (true|false)\n/);
    const build = read('android-build.yml');
    expect(build).toMatch(/REQUIRE_RELEASE_KEY" = "true" \]; then\n\s+echo "::error::/);
    // The keystore reaches the called workflow only when it is passed.
    for (const f of ['android.yml', 'release.yml']) expect(read(f)).toContain('ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}');
  });
});

describe('packaging and manifests', () => {
  it('Windows builds one installer per architecture, and the packaged app cannot be run as plain Node', () => {
    const cfg = require('../../electron-builder.config.cjs');
    expect(cfg.nsis.buildUniversalInstaller).toBe(false);
    expect(cfg.electronFuses).toMatchObject({ runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true });
  });

  it('Android declares the microphone and reads content: addresses only', () => {
    const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
    expect(manifest).toContain('android.permission.RECORD_AUDIO');
    expect(manifest).toContain('android.permission.MODIFY_AUDIO_SETTINGS');
    expect(manifest).not.toContain('android:scheme="file"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const paths = readFileSync('android/app/src/main/res/xml/file_paths.xml', 'utf8');
    expect([...paths.matchAll(/<(\w+-path)[^>]*path="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['cache-path shared/']);
    const java = readFileSync('android/app/src/main/java/io/github/socrtwo/quillfolio/QuillNativePlugin.java', 'utf8');
    expect(java).toMatch(/private boolean isAllowedUri\(Uri uri\)/);
    expect(java.match(/isAllowedUri\(/g)!.length).toBeGreaterThanOrEqual(4); // definition, intents, readUri, writeUri
    expect(java).toContain('Intent.ACTION_SEND_MULTIPLE.equals(action)');
    expect(java).toContain('Intent.ACTION_EDIT.equals(action)');
    expect(java).not.toMatch(/catch \(Exception e\) \{\s*Log\.e\(TAG, "Could not read incoming file"/);
    expect(existsSync('android/app/src/test')).toBe(false);
    expect(existsSync('android/app/src/androidTest')).toBe(false);
  });

  it('iOS declares why it uses the microphone', () => {
    expect(readFileSync('ios/App/App/Info.plist', 'utf8')).toContain('<key>NSMicrophoneUsageDescription</key>');
  });
});

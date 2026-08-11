# SpecFlowLab OriginPro 8.6 Windows Debug Handoff

Last updated: 2026-08-11

## Purpose

This note records the implementation, physical evidence, root cause, and
remaining packaged-application verification for the OriginPro 8.6 bridge.

## Root cause and resolved transport

The `-slog` / `-rs` startup transport is invalid for the tested OriginPro 8.6
installation. Origin opens but silently ignores both switches. The connection
problem is not LabTalk, file permissions, licensing, or the generated OGS path.

Physical evidence on 2026-08-11:

- Installed executable: `C:\Program Files\OriginLab\Origin\origin86.exe`.
- PE architecture: x86 (32-bit), OriginPro 8.6.0.
- First-run User Files and licence setup completed without a dialog or warning.
- The same LabTalk marker command entered in Command Window wrote
  `MANUAL_OK`, proving LabTalk and filesystem access work.
- The Command Window history contained no command injected by `-rs`, and
  `-slog` created no log.
- Origin's `Origin8.tlb` exposes `Application`, `ApplicationSI`, and
  `ApplicationCOMSI`; all Origin releases share these CLSIDs rather than
  exposing an Origin-8.6-specific ProgID.
- The 64-bit COM view still resolves to Origin 2021. The current user's 32-bit
  COM view resolves to the installed `origin86.exe`, so the two releases can
  coexist without changing the 64-bit registration.
- A 32-bit PowerShell call to `Origin.Application.Execute(...)` launched the
  exact installed `origin86.exe`, returned `true`, and wrote
  `ORIGIN86_COM32_OK`.
- The exact generated COM helper then passed a physical end-to-end test:
  `CreatePage`, a 2-by-4 `PutWorksheet` SAFEARRAY transfer, worksheet metadata,
  `Save`, automation-instance cleanup, and normal reopen all succeeded. The
  status was `completed`, warnings were empty, and the OPJ was 9,303 bytes.

The implementation now uses a bitness-matched Windows PowerShell COM helper
for the pre-2021 backend. It validates that COM launched the exact EXE selected
in SpecFlowLab, transfers staged numeric tables with `PutWorksheet`, and saves
with `Application.Save`. It does not depend on `-rs`, `newbook`, `open -w`, or
an OGS runtime handoff. After saving, the helper closes the isolated automation
instance and opens the project normally with the selected Origin executable.

The old command-line experiments below are retained as failure evidence; they
are no longer the proposed transport.

## Repository and build state

- Repository: <https://github.com/cyqllp/SpecFlowLab>
- Working branch: `agent/originpro-86-bridge`
- Commit: `02c926d77ad7890d8910b9800396de1471a4a61a`
- Commit title: `Fix OriginPro 8.6 LabTalk bridge`
- Draft pull request: <https://github.com/cyqllp/SpecFlowLab/pull/2>
- Successful GitHub Actions run: <https://github.com/cyqllp/SpecFlowLab/actions/runs/31450480050>
- Application version: `1.0.4`

All three CI jobs passed:

- JavaScript, frontend build, and Origin bridge tests
- Rust tests, formatting, and Clippy
- Windows Tauri packaging

The Windows workflow generated:

- `SpecFlowLab-portable.exe`
- `SpecFlowLab_1.0.4_x64-setup.exe`
- `SpecFlowLab_1.0.4_x64_en-US.msi`

The locally downloaded portable executable is:

```text
releases/SpecFlowLab-1.0.4-Origin86-CI-31450480050/releases/SpecFlowLab-portable.exe
```

Its SHA-256 is:

```text
08487cf8acf6963b5e5a7e4c7eff1fd5931b79b8ceccbfe2718464ef42510c99
```

CI and PE/package inspection prove that the Windows binary builds. They do not prove that a licensed OriginPro instance accepts and executes the bridge.

## Intended Origin support policy

- OriginPro 8.5 and earlier: rejected.
- OriginPro 8.6 through 2020: experimental COM worksheet bridge, output as `.opj`.
- OriginPro 2021 and later: Python automation bridge, output as `.opju`.
- OriginPro 8.6 is the minimum supported version because it is the oldest
  release for which the COM worksheet/save path has been physically validated.

## Relevant implementation

The Origin launch and monitoring logic is in:

```text
src-tauri/src/lib.rs
```

The Origin 8.6 table staging and COM import manifest are generated in:

```text
src-tauri/src/labtalk.rs
```

Origin discovery, version detection, and backend selection are in:

```text
src-tauri/src/origin.rs
```

For OriginPro 8.6, SpecFlowLab starts the 32-bit Windows PowerShell COM host and
performs the equivalent of:

```text
origin = CreateObject("Origin.Application")
verify newly launched process path == selected origin86.exe
for each staged dataset:
    page = origin.CreatePage(worksheet)
    origin.PutWorksheet(page, double[,])
origin.Save(output.opj)
origin.Exit()
open selected origin86.exe with the saved .opj
```

The COM helper:

1. Writes `<output>.origin-status.json` with state `started`.
2. Creates one Origin workbook per dataset.
3. Parses the staged invariant-culture table into a two-dimensional `double`
   SAFEARRAY and transfers it without opening an import dialog.
4. Designates wavelength as X and signal columns as Y, with axis values in
   column Long Names.
5. Saves the project as `.opj`, closes the hidden automation instance, and
   reopens the saved project in the selected Origin executable.
6. Writes final state `completed` only after the normal Origin window starts.

Remaining verification is limited to compiling the Rust/Tauri changes and
running the packaged SpecFlowLab UI once with a real project bundle. Cargo is
not installed in this local Windows environment, so Rust formatting, tests,
Clippy, and packaging must run in the existing CI workflow or a Rust-enabled
machine. The generated PowerShell helper itself has passed syntax parsing and
the physical Origin 8.6 end-to-end test described above.

The current per-user machine configuration selects
`C:\Program Files\OriginLab\Origin\origin86.exe` as Origin 8.6, x86. Its prior
configuration is preserved as
`origin-config.before-installed-origin86.bak.json` beside the active config.

## Historical copied-version test environment

Observed output directory:

```text
C:\Users\chaiy\Desktop\Origin 8.6
```

The OriginPro 8.6 directory is a copied version rather than a Setup-installed
version. SpecFlowLab selects its `origin86.exe`; the exact path and architecture
are recorded below.

## 2026-08-11 follow-up isolation result

The exact selected executable was recorded and inspected:

```text
C:\Users\chaiy\Desktop\Origin 8.6\origin86.exe
Product version: 8.6
File version: 8.6.0
PE architecture: x86 (32-bit)
```

The saved SpecFlowLab machine configuration incorrectly recorded this EXE as
64-bit because the application inferred bitness from the host OS when the file
name had no `_32` or `_64` suffix. This is a detection bug, but it does not
cause the LabTalk failure.

The minimal `-slog`/`-rs` marker-file test was run three times while no other
`origin86` process was active:

1. With the inherited SpecFlowLab working directory, the process stayed alive
   but created no main window, startup log, or marker file.
2. With the working directory explicitly set to the folder containing
   `origin86.exe`, the OriginPro 8.6 main window opened and used
   `C:\Users\chaiy\Documents\OriginLab\86\User Files`, but neither the startup
   log nor marker file was created, including after more than 120 seconds.
3. The exact documented command was then launched through `cmd.exe`, with the
   same Origin-folder working directory and a full 120-second observation
   window. Origin opened and remained responsive, but again created neither
   `C:\SFLTest\origin86-cmd.log` nor `C:\SFLTest\rs-ok-cmd.txt`.

The machine has no Origin 8.6 registration under the OriginLab registry keys;
only Origin 9.0 and 9.8 registrations were found. The copied 8.6 directory's
`Origin.ini` still contains a legacy `C:\Documents and Settings\All Users\...`
program-folder registration value. A normally installed Origin 2021 copy is
present separately under `D:\Softwares\OriginPro 2021`.

This proves two separate facts:

- SpecFlowLab must set the child working directory to the selected Origin EXE
  folder. That fixes initialization of this portable copy far enough to show
  its main window.
- The copied Origin 8.6 environment still does not accept `-slog` or `-rs`.
  SpecFlowLab cannot repair missing installer/licensing/registration state from
  application code. A Setup-installed and initialized Origin 8.6 instance is
  required for the next acceptance test.

The implementation was updated to set the working directory, detect PE
bitness, write launch diagnostics before spawning, and write a minimal
command-line probe before calling the full bridge script. A missing probe now
reports a command-line/startup-environment failure instead of claiming that
Origin successfully opened the bridge.

## Reproduction and observed failure

The Windows executable finds an Origin executable and opens OriginPro. After 120 seconds, SpecFlowLab reports:

```text
无法完成操作
OriginPro opened, but the LabTalk bridge did not start within 120 seconds.
Close all Origin windows and retry once.
Status: C:\Users\chaiy\Desktop\Origin 8.6\SF&SM.origin-status.json.
Startup log: C:\Users\chaiy\Desktop\Origin 8.6\SF&SM.origin-startup.log
```

Neither diagnostic file was created:

```text
SF&SM.origin-status.json
SF&SM.origin-startup.log
```

Repeated attempts created only numbered portable bundles:

```text
SF&SM.sflorigin
SF&SM-2.sflorigin
SF&SM-3.sflorigin
SF&SM-4.sflorigin
SF&SM-5.sflorigin
SF&SM-6.sflorigin
SF&SM-7.sflorigin
SF&SM-8.sflorigin
```

## What the current evidence proves

- SpecFlowLab successfully prepares the portable `.sflorigin` bundle before launching Origin.
- Windows successfully spawns an Origin executable because the Origin GUI opens.
- There is no evidence that Origin processed `-slog`.
- There is no evidence that Origin processed `-rs`.
- There is no evidence that `run.section()` reached the generated OGS file.
- The current UI wording `OriginPro opened` means only that process spawning succeeded. It must not be interpreted as a successful LabTalk handoff.
- The repeated `.sflorigin` files are expected from the collision-safe output naming logic; they do not indicate LabTalk execution.

The failure is therefore earlier than worksheet import or OPJ saving.

## Most likely causes to investigate

Investigate in this order:

1. The copied/non-installed Origin directory does not have a complete Origin 8.6 startup environment.
2. Origin is waiting for a first-run User Files Folder, license, or initialization dialog.
3. An existing background Origin process receives or discards the second launch, so the new command-line switches are not processed.
4. SpecFlowLab selected a launcher or executable that opens the GUI but does not process the expected switches.
5. Origin 8.6 parses the command line differently from the current Rust `Command::raw_arg` construction.
6. Spaces or the `&` character in the output path are exposing an Origin 8.6 parsing limitation. This is not yet proven, but it should be eliminated during isolation testing.

Installing Origin on a non-system drive is acceptable. Merely copying an Origin program folder without running its installer is not equivalent to a supported installation and may leave licensing, initialization files, registry state, and the per-user User Files Folder incomplete.

## Required manual isolation test

The test below failed for the copied 8.6 directory as recorded above. Repeat it
only after installing Origin 8.6 with Setup and completing first-run
initialization.

Do not run this test while another Origin process is active.

1. Open the exact Origin executable manually once.
2. Complete all licensing and User Files Folder prompts.
3. Create and save a blank OPJ.
4. Exit Origin normally.
5. Open Task Manager and confirm that no Origin process remains.
6. Open Windows `cmd.exe`, not PowerShell.
7. Run the following command after substituting the exact Origin executable path:

```bat
mkdir C:\SFLTest
"C:\exact\path\to\Origin86.exe" -slog "C:\SFLTest\origin86.log" -rs type -gbef "C:/SFLTest/rs-ok.txt";type "RS_OK";type -ge;
```

Expected output:

```text
C:\SFLTest\rs-ok.txt
```

Expected contents:

```text
RS_OK
```

Interpret the result as follows:

### `rs-ok.txt` is created

Origin 8.6 accepts command-line LabTalk. The next fix belongs in SpecFlowLab's Windows command construction, generated startup command, or OGS path syntax.

### Origin opens but neither `rs-ok.txt` nor `origin86.log` is created

The selected executable did not process the command-line switches. Verify installation, first-run configuration, exact executable selection, and whether another Origin process was already running.

### `origin86.log` exists but `rs-ok.txt` does not

Preserve the log. It should show whether LabTalk parsing began and where it failed.

### A first-run or license dialog appears

Complete it, exit Origin, confirm the process has ended, and repeat the test.

## Clean application retest

After the manual `-rs` test succeeds, retest SpecFlowLab using a simple ASCII path with no spaces or special characters:

```text
C:\SFLTest\test.opj
```

Before retrying, close all Origin windows and terminate any remaining Origin process. Preserve any generated diagnostic files before the next attempt because SpecFlowLab removes the previous status and startup log at the beginning of a new run.

## Windows development setup

Clone only the development branch instead of transferring the full macOS working directory:

```bat
git clone --branch agent/originpro-86-bridge --single-branch https://github.com/cyqllp/SpecFlowLab.git
cd SpecFlowLab
```

Install the prerequisites:

- Git for Windows
- Node.js 20
- Rust stable with the MSVC toolchain
- Microsoft Visual Studio Build Tools with Desktop development with C++
- WebView2 Runtime
- Python 3.11 if running the Python bridge tests
- A properly installed and configured OriginPro 8.6 for the physical bridge test

Install dependencies and run the desktop development application:

```bat
npm ci
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:dev
```

On Windows, the repository's `test:origin` script currently invokes `python3`. If that command is unavailable, run the equivalent test directly:

```bat
py -3 -m unittest discover -s integrations/origin/tests -p "test_*.py"
```

`npm run dev` alone starts only the Vite frontend and cannot exercise native Origin launching.

## Recommended diagnostic improvements in SpecFlowLab

Implement only after recording the manual test result:

1. Write an application-side launch diagnostic before spawning Origin. Include timestamp, resolved executable, detected version, backend, PID when available, staged OGS path, status path, log path, and a safely rendered command summary.
2. Distinguish `process spawned` from `LabTalk handoff reached` in the UI.
3. Detect early child-process exit and report its exit code instead of waiting the full 120 seconds.
4. Add a minimal Origin 8.6 probe that writes a marker file before attempting the full import OGS.
5. Test command construction with paths containing spaces, ampersands, Unicode, and parentheses.
6. Consider staging the OGS and diagnostic files under a short ASCII-only directory such as `C:\SFLBridge\<run-id>` during legacy testing.
7. Record the exact Origin executable selected by automatic discovery and allow the user to copy that path from the UI.
8. Warn when Origin opens into an unresolved first-run or User Files Folder state.

## Acceptance criteria for OriginPro 8.6

OriginPro 8.6 support should not be called verified until all of the following pass on a physical Windows system:

1. The exact Origin executable is detected and reported correctly.
2. A minimal command-line `-rs` marker-file probe succeeds.
3. The generated OGS creates a `started` status file.
4. Every selected dataset becomes a workbook with the correct wavelength and time orientation.
5. Numerical values retain expected precision and missing values remain missing.
6. The OPJ is saved successfully.
7. The completed status JSON is parseable and reports correct counts.
8. The saved OPJ closes and reopens in OriginPro 8.6 with the expected worksheets intact.
9. Failure messages distinguish launch, startup, LabTalk, import, save, and timeout failures.

## Evidence to capture from the next Windows session

Record and preserve:

- Exact Origin executable path and filename
- Whether Origin was installed with Setup or copied from another location
- OriginPro version and service release shown in Help/About
- 32-bit or 64-bit Origin
- Windows version
- Whether a User Files Folder and license prompt appeared
- Manual `-rs` command result
- `C:\SFLTest\origin86.log`
- `C:\SFLTest\rs-ok.txt`
- SpecFlowLab startup log and status JSON, if created
- Screenshot of any Origin dialog or LabTalk error
- Generated OPJ and the corresponding `.sflorigin` bundle

Do not merge the draft PR or claim verified OriginPro 8.6 support until this physical acceptance loop passes.

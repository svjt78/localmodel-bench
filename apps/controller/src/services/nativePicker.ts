import { execFile } from "node:child_process";

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) {
        // osascript exits non-zero when the user cancels the dialog.
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function pickFolder(): Promise<string | null> {
  const posixPath = await runOsascript(
    'POSIX path of (choose folder with prompt "Select a workspace folder")',
  );
  return posixPath || null;
}

export async function pickFile(): Promise<string | null> {
  const posixPath = await runOsascript('POSIX path of (choose file with prompt "Select a file to attach")');
  return posixPath || null;
}

export async function revealInFinder(targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("open", ["-R", targetPath], (err) => (err ? reject(err) : resolve()));
  });
}

export async function openWithDefaultApp(targetPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("open", [targetPath], (err) => (err ? reject(err) : resolve()));
  });
}

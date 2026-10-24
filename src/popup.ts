import { getJson, getToken } from "./github-api";

const input = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;
const mode = document.getElementById("mode")!;

async function load(): Promise<void> {
  const token = await getToken();
  if (!token) {
    mode.textContent = "Using your GitHub login.";
    input.placeholder = "github_pat_… or ghp_…";
    return;
  }
  input.placeholder = "Paste a new token to replace it";
  mode.textContent = "Using a token…";
  try {
    const user = await getJson<{ login: string }>("/user", token);
    mode.textContent = `Using a token for ${user.login}.`;
  } catch (e) {
    mode.textContent = `Using a token, but it failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function save(): Promise<void> {
  const token = input.value.trim();
  if (!token) {
    status.textContent = "Paste a token first.";
    return;
  }
  status.textContent = "Checking…";
  try {
    const user = await getJson<{ login: string }>("/user", token);
    await chrome.storage.local.set({ token });
    input.value = "";
    status.textContent = `Saved. Reload the PR page to use it.`;
    mode.textContent = `Using a token for ${user.login}.`;
    input.placeholder = "Paste a new token to replace it";
  } catch (e) {
    status.textContent = `Not saved: ${e instanceof Error ? e.message : String(e)}`;
  }
}

document.getElementById("save")!.addEventListener("click", () => void save());
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void save();
});

document.getElementById("clear")!.addEventListener("click", async () => {
  await chrome.storage.local.remove("token");
  status.textContent = "Token removed. Reload the PR page to use your login.";
  await load();
});

void load();

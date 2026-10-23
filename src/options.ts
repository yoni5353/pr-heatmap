import { getJson } from "./github-api";

const input = document.getElementById("token") as HTMLInputElement;
const status = document.getElementById("status")!;

async function load(): Promise<void> {
  const { token } = await chrome.storage.local.get("token");
  if (typeof token === "string" && token) {
    input.placeholder = "A token is saved. Paste a new one to replace it.";
  }
}

document.getElementById("save")!.addEventListener("click", async () => {
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
    status.textContent = `Saved. Authenticated as ${user.login}.`;
    await load();
  } catch (e) {
    status.textContent = `Not saved: ${e instanceof Error ? e.message : String(e)}`;
  }
});

document.getElementById("clear")!.addEventListener("click", async () => {
  await chrome.storage.local.remove("token");
  input.placeholder = "github_pat_… or ghp_…";
  status.textContent = "Token removed.";
});

void load();

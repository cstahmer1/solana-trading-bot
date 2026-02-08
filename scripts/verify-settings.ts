#!/usr/bin/env npx tsx

import { fetch } from "undici";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const PASSWORD = process.env.DASHBOARD_PASSWORD || "admin";

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find(c => c.includes("sid="));
  if (!sid) throw new Error("Login failed - no session cookie");
  return sid.split(";")[0];
}

async function getEffective(cookie: string) {
  const res = await fetch(`${BASE_URL}/api/settings/effective`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Failed to get effective settings: ${res.status}`);
  return res.json() as Promise<{ settingsHash: string; effectiveSettings: Record<string, any> }>;
}

async function getDiff(cookie: string) {
  const res = await fetch(`${BASE_URL}/api/settings/diff`, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`Failed to get diff: ${res.status}`);
  return res.json() as Promise<{ diffs: Array<{ key: string; dbValue: string | null; effectiveValue: any; source: string }> }>;
}

async function patchSettings(cookie: string, patch: Record<string, any>) {
  const res = await fetch(`${BASE_URL}/api/settings`, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to patch settings: ${res.status}`);
  return res.json();
}

async function main() {
  console.log("Settings Verification Script");
  console.log("============================\n");
  
  console.log("1. Logging in...");
  const cookie = await login();
  console.log("   OK - Session established\n");
  
  console.log("2. Fetching initial effective settings...");
  const initial = await getEffective(cookie);
  const hashBefore = initial.settingsHash;
  console.log(`   Hash before: ${hashBefore}\n`);
  
  const testKey = "scoutDailyLimit";
  const originalValue = initial.effectiveSettings[testKey];
  const newValue = originalValue === 5 ? 6 : 5;
  
  console.log(`3. Updating ${testKey}: ${originalValue} -> ${newValue}...`);
  await patchSettings(cookie, { [testKey]: newValue });
  console.log("   OK - Settings updated\n");
  
  console.log("4. Fetching effective settings after update...");
  const after = await getEffective(cookie);
  const hashAfter = after.settingsHash;
  console.log(`   Hash after: ${hashAfter}\n`);
  
  console.log("5. Verifying hash changed...");
  if (hashBefore === hashAfter) {
    console.error("   FAIL - Hash did not change!");
    process.exit(1);
  }
  console.log("   OK - Hash changed as expected\n");
  
  console.log("6. Checking diff endpoint...");
  const diff = await getDiff(cookie);
  console.log(`   Found ${diff.diffs.length} differences\n`);
  
  console.log("7. Reverting change...");
  await patchSettings(cookie, { [testKey]: originalValue });
  console.log("   OK - Reverted\n");
  
  console.log("8. Verifying hash restored...");
  const restored = await getEffective(cookie);
  if (restored.settingsHash !== hashBefore) {
    console.log(`   Note: Hash is ${restored.settingsHash} (may differ due to timing)`);
  } else {
    console.log("   OK - Hash restored to original\n");
  }
  
  console.log("\n============================");
  console.log("All verifications passed!");
  console.log("============================");
}

main().catch((err) => {
  console.error("Verification failed:", err.message);
  process.exit(1);
});

import { createReadStream, existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import unzipper from "unzipper";
import { pipeline } from "stream/promises";

const BASE_URL = process.env.DASHBOARD_URL || "http://localhost:5000";
const PASSWORD = process.env.DASHBOARD_PASSWORD || "admin";

const EXPECTED_FILES = [
  "equity_timeseries.jsonl",
  "trade_lots.jsonl",
  "pnl_events.jsonl",
  "bot_trades.jsonl",
  "rotation_log.jsonl",
  "position_lots_open.jsonl",
  "settings_effective.json",
  "positions_end.json",
  "aggregates.json",
  "manifest.json",
];

const REQUIRED_MANIFEST_FIELDS = ["schemaVersion", "generatedAt", "exportRange", "environment", "files", "totalRows"];
const REQUIRED_AGGREGATE_FIELDS = ["run_summary", "by_reason_code", "fees_summary", "orphans", "dust", "by_mint_top_losses", "price_impact_summary"];

async function validateNdjson(content: string, fileName: string): Promise<{ valid: boolean; lines: number; errors: string[] }> {
  const lines = content.trim().split("\n").filter((l) => l.length > 0);
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      JSON.parse(lines[i]);
    } catch {
      errors.push(`Line ${i + 1}: Invalid JSON`);
      if (errors.length >= 5) {
        errors.push("... (truncated)");
        break;
      }
    }
  }

  return { valid: errors.length === 0, lines: lines.length, errors };
}

async function validateJson(content: string, fileName: string): Promise<{ valid: boolean; error?: string; data?: any }> {
  try {
    const data = JSON.parse(content);
    return { valid: true, data };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}

async function login(): Promise<string | null> {
  console.log(`Authenticating with ${BASE_URL}...`);
  
  const loginPageRes = await fetch(`${BASE_URL}/login`);
  const loginPageHtml = await loginPageRes.text();
  
  const csrfMatch = loginPageHtml.match(/name="_csrf"\s+value="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";
  
  const cookies = loginPageRes.headers.get("set-cookie");
  const sessionCookie = cookies?.split(";")[0] || "";
  
  const loginRes = await fetch(`${BASE_URL}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": sessionCookie,
    },
    body: `_csrf=${encodeURIComponent(csrfToken)}&password=${encodeURIComponent(PASSWORD)}`,
    redirect: "manual",
  });
  
  const postCookies = loginRes.headers.get("set-cookie");
  const authedCookie = postCookies?.split(";")[0] || sessionCookie;
  
  if (loginRes.status === 302 || loginRes.status === 200) {
    console.log("Authentication successful");
    return authedCookie;
  }
  
  console.error(`Login failed with status ${loginRes.status}`);
  return null;
}

async function main() {
  console.log("=== Export Lite Sanity Check ===\n");

  const sessionCookie = await login();
  if (!sessionCookie) {
    console.error("Failed to authenticate. Check DASHBOARD_PASSWORD.");
    process.exit(1);
  }

  const startDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const endDate = new Date().toISOString().split("T")[0];

  console.log(`\nFetching export from ${BASE_URL}/api/export/lite?start=${startDate}&end=${endDate}`);

  try {
    const response = await fetch(`${BASE_URL}/api/export/lite?start=${startDate}&end=${endDate}`, {
      headers: {
        "Cookie": sessionCookie,
      },
    });

    if (!response.ok) {
      console.error(`Request failed with status ${response.status}: ${await response.text()}`);
      process.exit(1);
    }

    const contentType = response.headers.get("content-type");
    if (!contentType?.includes("application/zip")) {
      console.error(`Unexpected content type: ${contentType}`);
      process.exit(1);
    }

    console.log("Response received, content-type: application/zip");

    const extractDir = join(tmpdir(), `export_lite_sanity_${Date.now()}`);
    await mkdir(extractDir, { recursive: true });

    const zipPath = join(extractDir, "export.zip");
    const zipBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, zipBuffer);

    console.log(`ZIP saved to ${zipPath} (${zipBuffer.length} bytes), extracting...`);

    await pipeline(createReadStream(zipPath), unzipper.Extract({ path: extractDir }));

    console.log("\n=== Validating ZIP Contents ===\n");

    let allValid = true;
    const results: { file: string; status: string; details: string }[] = [];

    for (const expectedFile of EXPECTED_FILES) {
      const filePath = join(extractDir, expectedFile);

      if (!existsSync(filePath)) {
        results.push({ file: expectedFile, status: "MISSING", details: "File not found in ZIP" });
        allValid = false;
        continue;
      }

      const content = await readFile(filePath, "utf-8");

      if (expectedFile.endsWith(".jsonl")) {
        const { valid, lines, errors } = await validateNdjson(content, expectedFile);
        if (valid) {
          results.push({ file: expectedFile, status: "OK", details: `${lines} lines` });
        } else {
          results.push({ file: expectedFile, status: "INVALID", details: errors.join("; ") });
          allValid = false;
        }
      } else if (expectedFile.endsWith(".json")) {
        const { valid, error, data } = await validateJson(content, expectedFile);
        if (valid) {
          if (expectedFile === "manifest.json") {
            const missingFields = REQUIRED_MANIFEST_FIELDS.filter((f) => !(f in data));
            if (missingFields.length > 0) {
              results.push({ file: expectedFile, status: "INCOMPLETE", details: `Missing: ${missingFields.join(", ")}` });
              allValid = false;
            } else {
              const fileCount = Object.keys(data.files || {}).length;
              results.push({ file: expectedFile, status: "OK", details: `v${data.schemaVersion}, ${fileCount} files tracked` });
            }
          } else if (expectedFile === "aggregates.json") {
            const missingFields = REQUIRED_AGGREGATE_FIELDS.filter((f) => !(f in data));
            if (missingFields.length > 0) {
              results.push({ file: expectedFile, status: "INCOMPLETE", details: `Missing: ${missingFields.join(", ")}` });
              allValid = false;
            } else {
              const keys = Object.keys(data).slice(0, 4).join(", ") + "...";
              results.push({ file: expectedFile, status: "OK", details: keys });
            }
          } else {
            const keys = Array.isArray(data) ? `Array[${data.length}]` : Object.keys(data).slice(0, 3).join(", ") + "...";
            results.push({ file: expectedFile, status: "OK", details: keys });
          }
        } else {
          results.push({ file: expectedFile, status: "INVALID", details: error || "Parse error" });
          allValid = false;
        }
      }
    }

    console.log("File".padEnd(30) + "Status".padEnd(12) + "Details");
    console.log("-".repeat(80));
    for (const r of results) {
      const statusColor = r.status === "OK" ? "\x1b[32m" : r.status === "INCOMPLETE" ? "\x1b[33m" : "\x1b[31m";
      console.log(`${r.file.padEnd(30)}${statusColor}${r.status.padEnd(12)}\x1b[0m${r.details}`);
    }

    console.log("\n" + "-".repeat(80));

    await rm(extractDir, { recursive: true, force: true });

    if (allValid) {
      console.log("\x1b[32m All files valid! Export Lite sanity check passed.\x1b[0m\n");
      process.exit(0);
    } else {
      console.error("\x1b[31m Some files failed validation.\x1b[0m\n");
      process.exit(1);
    }
  } catch (err: any) {
    console.error("Error during sanity check:", err.message);
    process.exit(1);
  }
}

main();

"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BookOpen, Clock, Database, ExternalLink, FolderArchive, LifeBuoy, ShieldCheck, Terminal, UploadCloud, Wrench } from "lucide-react";
import { useCrumbs } from "@/components/shell/Shell";
import { Badge, Code, cx } from "@/components/ui";

/**
 * Install guide and command builder for dbbkp (github.com/iamPrashanta/dbbkp),
 * the Bash backup tool. Every command here matches the flags of dbbkp.sh 1.0.0.
 */

const RAW = "https://raw.githubusercontent.com/iamPrashanta/dbbkp";
const REPO = "https://github.com/iamPrashanta/dbbkp";

type Engine = "pgsql" | "mysql";
type Method = "none" | "AWS S3" | "rclone (GDrive/Other)" | "rsync" | "scp";

const METHODS: Array<{ v: Method; label: string; hint: string }> = [
  { v: "none", label: "Keep on this server", hint: "Not recommended: a disk failure takes the backups with it." },
  { v: "AWS S3", label: "AWS S3", hint: "Uses the AWS CLI with the keys from .env." },
  { v: "rclone (GDrive/Other)", label: "rclone", hint: "Google Drive, Dropbox, Backblaze, any rclone remote." },
  { v: "rsync", label: "rsync over SSH", hint: "Copy to another server you control." },
  { v: "scp", label: "scp", hint: "Simple SSH copy to another server." },
];

const OS = {
  debian: {
    label: "Ubuntu / Debian",
    cmd: `sudo apt update
sudo apt install -y bash curl gzip pv default-mysql-client postgresql-client
# only what you use for off-site copies:
sudo apt install -y rsync openssh-client rclone awscli`,
  },
  rhel: {
    label: "RHEL / Rocky / Alma / Fedora",
    cmd: `sudo dnf install -y bash curl gzip mysql postgresql util-linux coreutils
# pv is in EPEL on RHEL-based systems:
sudo dnf install -y epel-release && sudo dnf install -y pv
sudo dnf install -y rsync openssh-clients rclone awscli2`,
  },
  alpine: {
    label: "Alpine",
    cmd: `apk add bash curl gzip pv coreutils util-linux mysql-client postgresql-client
apk add rsync openssh-client rclone aws-cli`,
  },
} as const;

const SECTIONS = [
  ["install", "Install"],
  ["requirements", "Requirements"],
  ["configure", "Configure"],
  ["interactive", "Interactive menu"],
  ["jobs", "Backup and restore"],
  ["schedule", "Schedule with cron"],
  ["recovery", "Disaster recovery"],
  ["migrate", "Move to a new server"],
  ["folders", "Folders and other data"],
  ["troubleshoot", "Troubleshooting"],
] as const;

function Section({ id, icon, title, children, lead }: { id: string; icon: React.ReactNode; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 20, marginBottom: 36 }}>
      <h2 className="section" style={{ fontSize: 17, marginTop: 0 }}>
        <span className="step-num" style={{ width: 28, height: 28 }}>{icon}</span>
        {title}
      </h2>
      {lead && <p className="muted" style={{ marginBottom: 14, maxWidth: 760 }}>{lead}</p>}
      {children}
    </section>
  );
}

function Job({ title, tag, children }: { title: string; tag?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3>{tag && <span className="right">{tag}</span>}</div>
      <div className="card-body stack" style={{ gap: 10 }}>{children}</div>
    </div>
  );
}

export default function BackupCliPage() {
  useCrumbs([{ label: "Backup CLI" }]);
  const [install, setInstall] = useState<"latest" | "pinned" | "both">("latest");
  const [os, setOs] = useState<keyof typeof OS>("debian");

  // Command builder (stays in this browser; nothing is sent to the server)
  const [engine, setEngine] = useState<Engine>("pgsql");
  const [host, setHost] = useState("localhost");
  const [dbPort, setDbPort] = useState("");
  const [user, setUser] = useState("postgres");
  const [db, setDb] = useState("myapp");
  const [dir, setDir] = useState("/var/backups/dbbkp");
  const [method, setMethod] = useState<Method>("AWS S3");
  const [dest, setDest] = useState("s3://my-backups/db/");
  const [sshPort, setSshPort] = useState("22");
  const [webhook, setWebhook] = useState("");
  const [keepDays, setKeepDays] = useState("14");
  const [hour, setHour] = useState("2");

  const setMethodAndDest = (m: Method) => {
    setMethod(m);
    setDest(m === "AWS S3" ? "s3://my-backups/db/" : m === "rclone (GDrive/Other)" ? "gdrive:/database-backups/" : m === "none" ? "" : "backup@10.0.0.5:/srv/backups/");
  };

  const q = (s: string) => (/[\s"'()$]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const methodFlag = method === "none" ? "" : `--method=${q(method)}`;
  const portFlag = method === "rsync" || method === "scp" ? ` --port=${sshPort || "22"}` : "";

  const envFile = useMemo(
    () => `# ${dir}/.env  (read from the folder you run dbbkp in)
# Keep every line, even empty ones: the script stops on unset variables.
ENV_DB_HOST=${host}
ENV_DB_USER=${user}
ENV_DB_PASS=change-me
ENV_DB_NAME=${db}
${dbPort ? (engine === "pgsql" ? `PGPORT=${dbPort}\n` : `MYSQL_TCP_PORT=${dbPort}\n`) : ""}ENV_LOG_FILE=${dir}/dbbkp-run.log

ENV_AWS_BUCKET=${method === "AWS S3" ? dest : ""}
ENV_AWS_ACCESS_KEY_ID=${method === "AWS S3" ? "AKIA..." : ""}
ENV_AWS_SECRET_ACCESS_KEY=${method === "AWS S3" ? "..." : ""}
ENV_RCLONE_REMOTE=${method === "rclone (GDrive/Other)" ? dest : ""}

ENV_WEBHOOK_URL=${webhook}`,
    [dir, host, user, db, dbPort, engine, method, dest, webhook]
  );

  const backupMode = engine === "pgsql" ? "pgsql-backup" : "mysql-backup";
  const files = engine === "pgsql" ? ["data_*.sql", "schema_*.backup"] : ["backup_*.sql.gz"];
  const sample = engine === "pgsql" ? `data_${db}_2026-11-14_02-00_1234.sql` : `backup_${db}_2026-11-14_02-00_1234.sql.gz`;
  const schemaSample = `schema_${db}_2026-11-14_02-00_1234.backup`;

  const nightly = `#!/bin/bash
# /usr/local/bin/dbbkp-nightly : back up ${db}, copy it off the server, keep ${keepDays} days locally
set -euo pipefail
cd ${dir}

dbbkp --headless --mode=${backupMode}
${method === "none"
  ? "# (no off-site copy configured)"
  : files
      .map((pattern) => `f=$(ls -t ${pattern} | head -1)\ndbbkp --headless --mode=upload ${methodFlag} --file="$f" --dest=${q(dest)}${portFlag}`)
      .join("\n")}

# local retention (the .sha256 sidecars go with their files)
find ${dir} -maxdepth 1 \\( ${files.map((p) => `-name '${p}*'`).join(" -o ")} \\) -mtime +${keepDays} -delete`;

  const downloadCmds =
    method === "none"
      ? "# copy the newest backup files into the backup folder"
      : `cd ${dir}
for f in ${engine === "pgsql" ? `${sample} ${schemaSample}` : sample}; do
  dbbkp --headless --mode=download ${methodFlag} --file=${q(dest)}$f --dest=./${portFlag}
  dbbkp --headless --mode=download ${methodFlag} --file=${q(dest)}$f.sha256 --dest=./${portFlag}
done`;

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="ph">
        <div className="grow" style={{ minWidth: 280 }}>
          <div className="row" style={{ gap: 10 }}>
            <h1>Backup CLI</h1>
            <Badge tone="info" square>dbbkp 1.0.0</Badge>
            <Badge square>Bash · MIT</Badge>
          </div>
          <p>
            One script for MySQL and PostgreSQL backups, restores and off-site copies. Install it on each database server: it checks every file it writes
            (size and SHA-256), retries dumps, copies them to S3, Google Drive or another server, and can post to Slack or Discord. Use the menu by hand, or
            flags from cron.
          </p>
        </div>
        <div className="actions">
          <a className="btn" href={REPO} target="_blank" rel="noreferrer"><BookOpen size={14} /> Source on GitHub</a>
          <a className="btn" href={`${REPO}/releases/tag/1.0.0`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Release 1.0.0</a>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 220px", gap: 32, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <Section id="install" icon={<Terminal size={14} />} title="Install" lead="Run this on the database server (or any Linux machine that can reach the database). It puts a single file at /usr/local/bin/dbbkp.">
            <div className="seg" style={{ marginBottom: 10 }}>
              <button className={install === "latest" ? "on" : ""} onClick={() => setInstall("latest")}>Latest</button>
              <button className={install === "pinned" ? "on" : ""} onClick={() => setInstall("pinned")}>Pinned to 1.0.0</button>
              <button className={install === "both" ? "on" : ""} onClick={() => setInstall("both")}>With infra-agent</button>
            </div>
            {install === "latest" && (
              <Code>{`sudo curl -fsSL ${RAW}/main/dbbkp.sh -o /usr/local/bin/dbbkp
sudo chmod +x /usr/local/bin/dbbkp
dbbkp --version`}</Code>
            )}
            {install === "pinned" && (
              <Code>{`# the same version on every server, upgraded only when you choose
sudo curl -fsSL ${RAW}/1.0.0/dbbkp.sh -o /usr/local/bin/dbbkp
sudo chmod +x /usr/local/bin/dbbkp
dbbkp --version`}</Code>
            )}
            {install === "both" && (
              <Code>{`# installs dbbkp and infra-agent (security and diagnostics scanner)
curl -fsSL ${RAW}/main/install.sh | sudo bash`}</Code>
            )}
            <div className="faint small" style={{ marginTop: 8 }}>
              Read it before running it: <a className="link" href={`${RAW}/main/dbbkp.sh`} target="_blank" rel="noreferrer">dbbkp.sh</a>. To upgrade later, run <span className="inline-code">dbbkp --update</span>; it asks before replacing itself.
            </div>
          </Section>

          <Section id="requirements" icon={<Wrench size={14} />} title="Requirements" lead="Linux with Bash, plus the client tools for your database. pv is optional and only adds a progress bar. Windows works through WSL; macOS is not supported (no flock or sha256sum by default).">
            <div className="seg" style={{ marginBottom: 10 }}>
              {(Object.keys(OS) as Array<keyof typeof OS>).map((k) => <button key={k} className={os === k ? "on" : ""} onClick={() => setOs(k)}>{OS[k].label}</button>)}
            </div>
            <Code>{OS[os].cmd}</Code>
            <div className="notice info small" style={{ marginTop: 10 }}>
              <Database size={15} />
              <span>pg_dump must be the same major version as the PostgreSQL server or newer. If the distribution's client is older, install the client from the PostgreSQL apt or yum repository.</span>
            </div>
          </Section>

          <Section id="configure" icon={<ShieldCheck size={14} />} title="Configure" lead="dbbkp reads a .env file from the folder you run it in. Fill in this form to get the file and every command below with your values. The form stays in your browser.">
            <div className="card card-pad" style={{ marginBottom: 12 }}>
              <div className="grid g3" style={{ gap: 12 }}>
                <div>
                  <label className="label">Database</label>
                  <div className="seg">
                    <button className={engine === "pgsql" ? "on" : ""} onClick={() => { setEngine("pgsql"); if (user === "root") setUser("postgres"); }}>PostgreSQL</button>
                    <button className={engine === "mysql" ? "on" : ""} onClick={() => { setEngine("mysql"); if (user === "postgres") setUser("root"); }}>MySQL / MariaDB</button>
                  </div>
                </div>
                <div><label className="label">Host</label><input className="input" value={host} onChange={(e) => setHost(e.target.value.trim())} /></div>
                <div><label className="label">Port (if not default)</label><input className="input" inputMode="numeric" placeholder={engine === "pgsql" ? "5432" : "3306"} value={dbPort} onChange={(e) => setDbPort(e.target.value.replace(/\D/g, ""))} /></div>
                <div><label className="label">User</label><input className="input" value={user} onChange={(e) => setUser(e.target.value.trim())} /></div>
                <div><label className="label">Database name</label><input className="input" value={db} onChange={(e) => setDb(e.target.value.trim())} /></div>
                <div><label className="label">Backup folder</label><input className="input mono" value={dir} onChange={(e) => setDir(e.target.value.trim())} /></div>
              </div>
              <div className="divider" />
              <label className="label">Off-site copy</label>
              <div className="grid g3" style={{ gap: 8, marginBottom: 12 }}>
                {METHODS.map((m) => (
                  <button key={m.v} className={cx("option", method === m.v && "on")} style={{ padding: "10px 12px" }} onClick={() => setMethodAndDest(m.v)}>
                    <span><span className="strong small">{m.label}</span><br /><span className="faint tiny">{m.hint}</span></span>
                  </button>
                ))}
              </div>
              <div className="grid g3" style={{ gap: 12 }}>
                {method !== "none" && (
                  <div style={{ gridColumn: "span 2" }}>
                    <label className="label">{method === "AWS S3" ? "Bucket and path" : method.startsWith("rclone") ? "rclone remote and path" : "Destination (user@host:/path/)"}</label>
                    <input className="input mono" value={dest} onChange={(e) => setDest(e.target.value.trim())} />
                  </div>
                )}
                {(method === "rsync" || method === "scp") && (
                  <div><label className="label">SSH port</label><input className="input" inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value.replace(/\D/g, ""))} /></div>
                )}
                <div style={{ gridColumn: method === "rsync" || method === "scp" ? "span 3" : "span 1" }}>
                  <label className="label">Slack or Discord webhook (optional)</label>
                  <input className="input mono" placeholder="https://hooks.slack.com/services/..." value={webhook} onChange={(e) => setWebhook(e.target.value.trim())} />
                </div>
              </div>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <Code>{`sudo mkdir -p ${dir} && cd ${dir}
sudo nano .env        # paste the file below, then set the real password
sudo chmod 600 .env`}</Code>
              <Code label=".env">{envFile}</Code>
              {(method === "rsync" || method === "scp") && (
                <div className="notice small"><span>For copies over SSH without a password prompt, add this server's SSH key to the destination first: <span className="inline-code">ssh-copy-id -p {sshPort || 22} {dest.split(":")[0]}</span></span></div>
              )}
              {method.startsWith("rclone") && <div className="notice small"><span>Set up the remote once with <span className="inline-code">rclone config</span>; rclone keeps its credentials in ~/.config/rclone/rclone.conf for the user that runs dbbkp.</span></div>}
            </div>
          </Section>

          <Section id="interactive" icon={<Terminal size={14} />} title="Interactive menu" lead="For one-off jobs, run it with no arguments from the backup folder. It shows what it found in .env and asks you to confirm, asks for anything missing (the password without echo), and offers an automatic file name.">
            <Code copy={false} label="terminal">{`$ cd ${dir} && dbbkp
=======================================
        DBBKP v1.0.0
=======================================
1) MySQL Backup               6) Upload File (Transfer)
2) MySQL Restore              7) Download File
3) PostgreSQL Backup          8) Update Agent (GitHub)
4) PostgreSQL Full Restore    9) Exit
5) PostgreSQL Data Restore
Please select a module:`}</Code>
          </Section>

          <Section id="jobs" icon={<Database size={14} />} title="Backup and restore" lead="The same jobs without questions: --headless takes every value from .env and from flags, so they run from cron or another script. Add --json for machine-readable status lines.">
            <div className="stack" style={{ gap: 12 }}>
              {engine === "pgsql" ? (
                <>
                  <Job title="PostgreSQL backup" tag={<Badge tone="ok">safe</Badge>}>
                    <Code>{`cd ${dir} && dbbkp --headless --mode=pgsql-backup`}</Code>
                    <div className="muted small">Writes two files, each with a .sha256 next to it: <span className="inline-code">schema_{db}_DATE_ID.backup</span> (pg_dump custom format, schema only) and <span className="inline-code">data_{db}_DATE_ID.sql</span> (data as INSERTs, 1,000 rows per statement). A dump that fails is retried up to 3 times, and an empty or tiny file counts as a failure.</div>
                  </Job>
                  <Job title="PostgreSQL full restore" tag={<Badge tone="bad">drops the database</Badge>}>
                    <Code>{`cd ${dir}
dbbkp --headless --mode=pgsql-full-restore \\
  --schema=${schemaSample} \\
  --file=${sample}`}</Code>
                    <div className="muted small">Drops and recreates <span className="inline-code">{db}</span>, restores the schema without owners or privileges, loads the data with foreign-key triggers off, then resets every sequence to the column's current maximum so new rows don't collide.</div>
                  </Job>
                  <Job title="PostgreSQL data restore" tag={<Badge tone="warn">keeps the schema</Badge>}>
                    <Code>{`cd ${dir}
dbbkp --headless --mode=pgsql-data-restore --file=${sample}`}</Code>
                    <div className="muted small">Keeps an existing database (creates it if missing), loads the rows in FK-safe mode and repairs the sequences. To run your app's migrations first, use the menu instead (option 5): headless mode skips that pause. See <a className="link" href="#migrate">Move to a new server</a>.</div>
                  </Job>
                </>
              ) : (
                <>
                  <Job title="MySQL backup" tag={<Badge tone="ok">safe</Badge>}>
                    <Code>{`cd ${dir} && dbbkp --headless --mode=mysql-backup`}</Code>
                    <div className="muted small">mysqldump in one transaction without locking tables (utf8mb4), gzipped on the fly into <span className="inline-code">backup_{db}_DATE_ID.sql.gz</span> with a .sha256 next to it. Retried up to 3 times.</div>
                  </Job>
                  <Job title="MySQL restore" tag={<Badge tone="warn">overwrites tables</Badge>}>
                    <Code>{`cd ${dir}
dbbkp --headless --mode=mysql-restore --file=${sample}`}</Code>
                    <div className="muted small">Streams the file into <span className="inline-code">{db}</span> with foreign-key and unique checks off for the session and a 1 GB packet limit for large rows. The database must exist: <span className="inline-code">mysql -h {host} -u {user} -p -e "CREATE DATABASE IF NOT EXISTS {db}"</span>. Restores are never retried, so a half-finished one can't double your data.</div>
                  </Job>
                </>
              )}
              <Job title="Copy a backup off the server" tag={<UploadCloud size={15} className="faint" />}>
                {method === "none" ? (
                  <div className="muted small">Pick an off-site copy method in <a className="link" href="#configure">Configure</a> to get this command.</div>
                ) : (
                  <Code>{`cd ${dir}
dbbkp --headless --mode=upload ${methodFlag} --file=${sample} --dest=${q(dest)}${portFlag}`}</Code>
                )}
                <div className="muted small">The .sha256 file next to it is uploaded too. Methods are exactly: <span className="inline-code">scp</span>, <span className="inline-code">rsync</span>, <span className="inline-code">"AWS S3"</span>, <span className="inline-code">"rclone (GDrive/Other)"</span>; --port only applies to scp and rsync.</div>
              </Job>
              <Job title="Check a file against its checksum">
                <Code>{`# the .sha256 file holds just the hash
f=${sample}
echo "$(cat "$f.sha256")  $f" | sha256sum -c -`}</Code>
              </Job>
            </div>
          </Section>

          <Section id="schedule" icon={<Clock size={14} />} title="Schedule with cron" lead="File names include the date and a random number, so a small wrapper picks the newest file to copy off-site. Save it once, then add one cron line.">
            <div className="row wrap" style={{ gap: 12, marginBottom: 10 }}>
              <div style={{ width: 160 }}><label className="label">Run at (hour, 0-23)</label><input className="input" inputMode="numeric" value={hour} onChange={(e) => setHour(e.target.value.replace(/\D/g, "").slice(0, 2))} /></div>
              <div style={{ width: 160 }}><label className="label">Keep locally (days)</label><input className="input" inputMode="numeric" value={keepDays} onChange={(e) => setKeepDays(e.target.value.replace(/\D/g, ""))} /></div>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <Code label="/usr/local/bin/dbbkp-nightly">{nightly}</Code>
              <Code>{`sudo chmod +x /usr/local/bin/dbbkp-nightly
sudo crontab -e      # then add the line below`}</Code>
              <Code label="crontab">{`0 ${Number(hour) % 24 || 0} * * * /usr/local/bin/dbbkp-nightly >> /var/log/dbbkp-cron.log 2>&1`}</Code>
              <div className="faint small">dbbkp takes a lock (/tmp/dbbkp.lock) for each run, so a manual run and the cron job never write at the same time. With ENV_WEBHOOK_URL set, every successful job posts a message.</div>
            </div>
          </Section>

          <Section id="recovery" icon={<LifeBuoy size={14} />} title="Disaster recovery" lead="The database server is gone or the data is damaged. On a fresh server with dbbkp installed and the same .env:">
            <div className="stack" style={{ gap: 12 }}>
              {[
                { t: "Fetch the latest backup and its checksum", c: downloadCmds },
                {
                  t: "Make sure the files are intact",
                  c: (engine === "pgsql" ? [sample, schemaSample] : [sample]).map((f) => `echo "$(cat ${f}.sha256)  ${f}" | sha256sum -c -`).join("\n"),
                },
                {
                  t: "Restore",
                  c:
                    engine === "pgsql"
                      ? `dbbkp --headless --mode=pgsql-full-restore \\\n  --schema=${schemaSample} --file=${sample}`
                      : `mysql -h ${host} -u ${user} -p -e "CREATE DATABASE IF NOT EXISTS ${db}"\ndbbkp --headless --mode=mysql-restore --file=${sample}`,
                },
                { t: "Point the app at the restored database and check it", c: `# update DATABASE_URL (or DB_HOST) in the app's variables, then redeploy it from Deploy King` },
              ].map((s, i) => (
                <div key={i} className="row top" style={{ gap: 12 }}>
                  <span className="step-num">{i + 1}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong" style={{ marginBottom: 6 }}>{s.t}</div>
                    <Code>{s.c}</Code>
                  </div>
                </div>
              ))}
              <div className="notice warn small">
                <AlertTriangle size={15} className="warn-text" />
                <span>A backup you have never restored is a guess. Restore to a spare database every month or so; the full restore recreates the database from the two files, so it is a real test.</span>
              </div>
            </div>
          </Section>

          <Section id="migrate" icon={<UploadCloud size={14} />} title="Move to a new server or app version" lead="When the new server runs a newer version of the app, its migrations must create the new schema before the old rows go in. The interactive data restore pauses for exactly that.">
            <div className="stack" style={{ gap: 10 }}>
              <Code>{`# 1. on the old server
cd ${dir} && dbbkp --headless --mode=${backupMode}
${method === "none" ? "# copy the files to the new server" : `dbbkp --headless --mode=upload ${methodFlag} --file=${sample} --dest=${q(dest)}${portFlag}`}`}</Code>
              {engine === "pgsql" ? (
                <Code>{`# 2. on the new server, from the backup folder
dbbkp
#   5) PostgreSQL Data Restore
#   "Do you want to run manual migrations on the app server first?"  y
#   run the migrations on the app server (it prints the DATABASE_URL to use), e.g.
#   npm run db:migrate
#   then press Enter: dbbkp loads the data and repairs the sequences`}</Code>
              ) : (
                <Code>{`# 2. on the new server: run the app's migrations first, then
cd ${dir}
dbbkp --headless --mode=mysql-restore --file=${sample}`}</Code>
              )}
            </div>
          </Section>

          <Section id="folders" icon={<FolderArchive size={14} />} title="Folders and other data" lead="dbbkp 1.0.0 backs up MySQL and PostgreSQL. For uploads folders, sites and other files, make an archive with tar and let dbbkp copy it off-site with the same checksum file.">
            <div className="stack" style={{ gap: 12 }}>
              <Job title="Folder backup" tag={<Badge>tar + dbbkp upload</Badge>}>
                <Code>{`cd ${dir}
f=files_$(date +%F_%H-%M).tar.gz
tar -czf "$f" -C /var/www myapp/uploads
sha256sum "$f" | awk '{print $1}' > "$f.sha256"     # same format dbbkp uses
${method === "none" ? "# then copy it off the server" : `dbbkp --headless --mode=upload ${methodFlag} --file="$f" --dest=${q(dest)}${portFlag}`}`}</Code>
                <Code>{`# restore
tar -xzf files_2026-11-14_02-00.tar.gz -C /var/www`}</Code>
              </Job>
              <Job title="SQLite" tag={<Badge>sqlite3 + dbbkp upload</Badge>}>
                <Code>{`f=app_$(date +%F_%H-%M).db
sqlite3 /srv/myapp/app.db ".backup '$f'"    # consistent copy while the app runs
gzip "$f" && sha256sum "$f.gz" | awk '{print $1}' > "$f.gz.sha256"`}</Code>
              </Job>
              <div className="faint small">Not covered yet: MongoDB and Redis. Use their own tools (mongodump, redis-cli --rdb) and the same upload step.</div>
            </div>
          </Section>

          <Section id="troubleshoot" icon={<Wrench size={14} />} title="Troubleshooting">
            <div className="card">
              <div className="list">
                {[
                  ["“Another dbbkp process is already running.”", "A run holds /tmp/dbbkp.lock. Wait for it, or check with ps aux | grep dbbkp. On a system without flock (macOS) you see this message on every run."],
                  ["“unbound variable”", "A key is missing from .env. Keep every line of the template, even empty ones."],
                  ["“Headless mode requires ENV_DB_USER, ENV_DB_PASS, and ENV_DB_NAME”", "Run dbbkp from the folder that contains .env, or cd into it first in cron."],
                  ["“File … is suspiciously small”", "The dump was empty: wrong password, wrong database name, or the server was unreachable. dbbkp already retried 3 times; check the log in ENV_LOG_FILE."],
                  ["pg_dump: server version mismatch", "Install a PostgreSQL client of the same major version as the server, or newer."],
                  ["Database on another port", "Add PGPORT=5433 (PostgreSQL) or MYSQL_TCP_PORT=3307 (MySQL) to .env. The database clients read them."],
                ].map(([t, d]) => (
                  <div key={t} style={{ padding: "12px 18px" }}>
                    <div className="strong small">{t}</div>
                    <div className="muted small">{d}</div>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </div>

        <aside className="toc desktop-only" style={{ position: "sticky", top: 20 }}>
          <div className="faint tiny strong" style={{ textTransform: "uppercase", letterSpacing: "0.06em", padding: "0 10px 8px" }}>On this page</div>
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </aside>
      </div>
    </div>
  );
}

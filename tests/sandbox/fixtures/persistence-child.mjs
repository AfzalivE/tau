import fs from "node:fs";

const [cwd, host, mode] = process.argv.slice(2);
// Observe real lease contention before proper-lockfile captures graceful-fs methods.
const mkdir = fs.mkdir;
fs.mkdir = (...args) => {
  const callback = args.pop();
  mkdir(...args, (error, ...values) => {
    if (error?.code === "EEXIST" && String(args[0]).endsWith("sandbox.json.lock")) {
      process.send({ event: "contended" });
    }
    callback(error, ...values);
  });
};
if (mode === "cleanup-failure") {
  const rmdir = fs.rmdir;
  fs.rmdir = (...args) => {
    if (String(args[0]).endsWith("sandbox.json.lock")) {
      args.at(-1)(Object.assign(new Error("Ink spilled during lease cleanup"), { code: "EACCES" }));
    } else rmdir(...args);
  };
}
const { saveGlobalPermission, SandboxPermissionSaveError } =
  await import("../../../extensions/sandbox/permissions/persistence.js");
process.once("message", async () => {
  try {
    await saveGlobalPermission(
      cwd,
      {
        section: "network",
        list: "allowedDomains",
        op: "add",
        value: host,
        target: host,
      },
      { projectTrusted: false },
    );
    if (mode === "cleanup-failure") throw new Error("Expected a cleanup failure after publication");
    process.send({ event: "done" }, () => process.disconnect());
  } catch (error) {
    if (mode === "cleanup-failure" && error instanceof SandboxPermissionSaveError && error.saved) {
      process.send({ event: "saved-cleanup-failure" }, () => process.disconnect());
    } else {
      process.send({ event: "failed", error: String(error) }, () => process.disconnect());
      process.exitCode = 1;
    }
  }
});
process.send({ event: "ready" });

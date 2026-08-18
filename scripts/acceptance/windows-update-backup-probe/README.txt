Wentor Windows update-backup phase probe

Purpose:
- Diagnose only the user-file backup boundary that runs before a managed update.
- Compare Windows PowerShell 5.1 and PowerShell 7 on the same native host.

Safety:
- Does not update Git, install packages, read credentials, or modify a Profile.
- Copies only the seven protected update paths into an ACL-private task root.
- Never prints file contents, hashes, command lines, credentials, or Profile data.
- Removes only its exact task-owned temporary root after each run.

Run:
1. Keep Research-Claw installed at C:\Users\<you>\research-claw.
2. Double-click Run-Wentor-Update-Backup-Probe.cmd.
3. No keyboard input is required.
4. Send the two newest Wentor-Update-Backup-Probe TXT reports from the folder
   that opens when the probe finishes.

This probe is diagnostic evidence. It is not an installer or updater.

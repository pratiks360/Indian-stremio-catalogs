# rclone Google Drive mount — one-time VPS setup

Run once, manually, on the VPS. This is interactive (Google OAuth
consent) and cannot be scripted end-to-end.

1. Install rclone:

   ```bash
   curl https://rclone.org/install.sh | sudo bash
   ```

2. Create the mount point:

   ```bash
   sudo mkdir -p /mnt/gdrive
   sudo chown ubuntu:ubuntu /mnt/gdrive
   ```

3. Configure the `gdrive` remote:

   ```bash
   rclone config
   ```

   Choose `n` (new remote), name it exactly `gdrive`, type `drive`
   (Google Drive), leave client_id/client_secret blank (use rclone's own),
   scope `drive` (full access), leave root_folder_id blank, and when asked
   "Use auto config?" answer `n` if this is a headless SSH session — it
   will print a URL to open in a browser on any machine, plus a place to
   paste the resulting verification code back into the SSH session.

4. Enable `user_allow_other` for `--allow-other` to work:

   ```bash
   echo 'user_allow_other' | sudo tee -a /etc/fuse.conf
   ```

5. Install and start the mount service:

   ```bash
   sudo cp deploy/rclone-gdrive-mount.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now rclone-gdrive-mount.service
   ```

6. Verify:

   ```bash
   systemctl is-active rclone-gdrive-mount
   ls /mnt/gdrive
   ```

   `ls` should list the contents of your Google Drive root (empty is fine
   on a fresh account) without hanging or erroring.

7. Set `GDRIVE_MOUNT_PATH=/mnt/gdrive` in `.env` if you used a different
   mount point than the default.

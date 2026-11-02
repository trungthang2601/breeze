-- Internal drives per device (model, size, SSD/HDD, bus, serial), reported by
-- the Windows agent from Win32_DiskDrive + MSFT_PhysicalDisk. USB drives are
-- excluded agent-side. Lets the Device Inventory report list drive serials.
-- NULL = never reported (older agent, non-Windows host, WMI failure).
-- No row writes in this file, so no set_config('breeze.scope', 'system')
-- elevation is needed.

ALTER TABLE device_hardware
  ADD COLUMN IF NOT EXISTS physical_disks jsonb;

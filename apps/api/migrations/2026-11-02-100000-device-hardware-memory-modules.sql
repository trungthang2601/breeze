-- Installed RAM sticks per device (slot, size, speed, vendor, part number),
-- reported by the Windows agent from Win32_PhysicalMemory. Lets the device
-- pages and the Device Inventory report answer "1 stick or 2?".
-- NULL = never reported (older agent, non-Windows host, WMI failure).
-- No row writes in this file, so no set_config('breeze.scope', 'system')
-- elevation is needed.

ALTER TABLE device_hardware
  ADD COLUMN IF NOT EXISTS memory_modules jsonb;

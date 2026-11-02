//go:build linux

package collectors

import (
	"log/slog"
	"os"
	"strings"
	"sync"
)

var dmiWarningOnce sync.Once

// readDMI reads a value from /sys/class/dmi/id/.
// Logs a warning once if DMI files are inaccessible (e.g. no root, containers).
func readDMI(name string) string {
	path := "/sys/class/dmi/id/" + name
	if statInfo, err := os.Stat(path); err == nil && statInfo.Size() > collectorFileReadLimit {
		dmiWarningOnce.Do(func() {
			slog.Warn("cannot read oversized DMI data", "path", path)
		})
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		dmiWarningOnce.Do(func() {
			slog.Warn("cannot read DMI data", "path", path, "error", err.Error())
		})
		return ""
	}
	return truncateCollectorString(strings.TrimSpace(string(data)))
}

func collectPlatformHardware(hw *HardwareInfo) {
	hw.SerialNumber = readDMI("product_serial")
	hw.Manufacturer = readDMI("sys_vendor")
	hw.Model = readDMI("product_name")
	hw.MotherboardManufacturer = cleanHardwareIdentityValue(readDMI("board_vendor"))
	hw.MotherboardProduct = cleanHardwareIdentityValue(readDMI("board_name"))
	hw.MotherboardVersion = cleanHardwareIdentityValue(readDMI("board_version"))
	hw.BIOSVersion = readDMI("bios_version")

	// RAM sticks (slot, size, speed, vendor, part, serial) from SMBIOS type 17.
	// dmidecode needs root — the agent service runs as root; when it is missing
	// or fails the field is omitted and the server keeps the previous list.
	if memOut, memErr := runCollectorOutput(collectorLongCommandTimeout, "dmidecode", "-t", "17"); memErr != nil {
		slog.Debug("dmidecode -t 17 failed; RAM sticks not reported", "error", memErr.Error())
	} else {
		hw.MemoryModules = parseDmidecodeMemory(string(memOut))
	}

	// Internal drives with model and serial (USB drives skipped).
	if diskOut, diskErr := runCollectorOutput(collectorLongCommandTimeout, "lsblk", "-J", "-b", "-d", "-o", "NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE"); diskErr != nil {
		slog.Debug("lsblk failed; physical disks not reported", "error", diskErr.Error())
	} else {
		hw.PhysicalDisks = parseLsblkDisks(diskOut)
	}

	// GPU via lspci (with timeout)
	out, err := runCollectorOutput(collectorLongCommandTimeout, "lspci")
	if err != nil {
		slog.Warn("lspci failed", "error", err.Error())
	} else {
		for _, line := range strings.Split(string(out), "\n") {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
				parts := strings.SplitN(line, ": ", 2)
				if len(parts) == 2 {
					hw.GPUModel = truncateCollectorString(strings.TrimSpace(parts[1]))
					break
				}
			}
		}
	}
}

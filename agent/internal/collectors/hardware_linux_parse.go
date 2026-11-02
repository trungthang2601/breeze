package collectors

import (
	"bufio"
	"encoding/json"
	"strconv"
	"strings"
)

// Linux RAM-stick and drive parsers. Build-tag free so the tests run on every
// CI platform; hardware_linux.go feeds them `dmidecode -t 17` and
// `lsblk -J -b -d` output.

// parseDmidecodeMemory turns `dmidecode -t 17` (Memory Device) output into RAM
// sticks. Empty slots ("No Module Installed") are dropped.
func parseDmidecodeMemory(out string) []MemoryModule {
	var modules []MemoryModule
	var cur map[string]string
	flush := func() {
		if cur == nil {
			return
		}
		if mod, ok := dmidecodeModule(cur); ok && len(modules) < maxMemoryModules {
			modules = append(modules, mod)
		}
		cur = nil
	}
	scanner := bufio.NewScanner(strings.NewReader(out))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "Memory Device" {
			flush()
			cur = map[string]string{}
			continue
		}
		if strings.HasPrefix(line, "Handle ") {
			flush()
			continue
		}
		if cur == nil {
			continue
		}
		if key, value, ok := strings.Cut(trimmed, ":"); ok {
			cur[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	flush()
	return modules
}

func dmidecodeModule(f map[string]string) (MemoryModule, bool) {
	sizeMB := dmidecodeSizeMB(f["Size"])
	if sizeMB == 0 {
		return MemoryModule{}, false
	}
	mod := MemoryModule{
		Slot:         truncateCollectorString(strings.TrimSpace(f["Locator"])),
		CapacityMB:   sizeMB,
		Manufacturer: cleanMemoryVendorValue(f["Manufacturer"]),
		PartNumber:   cleanMemoryVendorValue(f["Part Number"]),
		SerialNumber: cleanMemoryVendorValue(f["Serial Number"]),
	}
	speed := dmidecodeSpeed(f["Configured Memory Speed"])
	if speed == 0 {
		speed = dmidecodeSpeed(f["Configured Clock Speed"]) // older dmidecode
	}
	if speed == 0 {
		speed = dmidecodeSpeed(f["Speed"])
	}
	mod.SpeedMHz = speed
	return mod, true
}

// "8 GB", "8192 MB", "16384 MB", "No Module Installed", "Unknown".
func dmidecodeSizeMB(value string) uint64 {
	fields := strings.Fields(value)
	if len(fields) < 2 {
		return 0
	}
	n, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || n <= 0 {
		return 0
	}
	switch strings.ToUpper(fields[1]) {
	case "KB":
		return uint64(n / 1024)
	case "MB":
		return uint64(n)
	case "GB":
		return uint64(n * 1024)
	case "TB":
		return uint64(n * 1024 * 1024)
	}
	return 0
}

// "3200 MT/s", "2666 MHz", "Unknown".
func dmidecodeSpeed(value string) uint32 {
	fields := strings.Fields(value)
	if len(fields) == 0 {
		return 0
	}
	n, err := strconv.ParseUint(fields[0], 10, 32)
	if err != nil || n == 0 || n >= 100000 {
		return 0
	}
	return uint32(n)
}

type lsblkDiskJSON struct {
	Blockdevices []struct {
		Name   string          `json:"name"`
		Model  *string         `json:"model"`
		Serial *string         `json:"serial"`
		Size   json.RawMessage `json:"size"`
		Rota   json.RawMessage `json:"rota"`
		Tran   *string         `json:"tran"`
		Type   string          `json:"type"`
	} `json:"blockdevices"`
}

// parseLsblkDisks turns `lsblk -J -b -d -o NAME,MODEL,SERIAL,SIZE,ROTA,TRAN,TYPE`
// into internal drives. USB, optical, loop/zram/RAM devices are dropped. Older
// lsblk prints numbers and booleans as strings; both shapes are accepted.
func parseLsblkDisks(data []byte) []PhysicalDisk {
	var parsed lsblkDiskJSON
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	var disks []PhysicalDisk
	for _, d := range parsed.Blockdevices {
		if d.Type != "disk" {
			continue
		}
		name := strings.ToLower(d.Name)
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "sr") {
			continue
		}
		tran := strings.ToLower(strDeref(d.Tran))
		if tran == "usb" {
			continue
		}
		sizeBytes := rawNumber(d.Size)
		sizeGB := uint64(sizeBytes / 1e9)
		if sizeGB == 0 {
			continue
		}
		media := ""
		switch rawBool(d.Rota) {
		case 1:
			media = "HDD"
		case 0:
			media = "SSD"
		}
		bus := ""
		switch tran {
		case "nvme":
			bus = "NVMe"
		case "sata", "ata":
			bus = "SATA"
		case "sas":
			bus = "SAS"
		case "":
		default:
			bus = strings.ToUpper(tran)
		}
		if strings.HasPrefix(name, "nvme") {
			bus = "NVMe"
			media = "SSD"
		}
		disks = append(disks, PhysicalDisk{
			Model:        truncateCollectorString(strings.TrimSpace(strDeref(d.Model))),
			SizeGB:       sizeGB,
			MediaType:    media,
			BusType:      bus,
			SerialNumber: cleanDiskSerial(strDeref(d.Serial)),
		})
		if len(disks) == maxPhysicalDisks {
			break
		}
	}
	return disks
}

func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func rawNumber(raw json.RawMessage) float64 {
	var n float64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if v, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return v
		}
	}
	return 0
}

// rawBool returns 1 for true/"1", 0 for false/"0", -1 when unknown.
func rawBool(raw json.RawMessage) int {
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		if b {
			return 1
		}
		return 0
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		switch strings.TrimSpace(s) {
		case "1", "true":
			return 1
		case "0", "false":
			return 0
		}
	}
	return -1
}

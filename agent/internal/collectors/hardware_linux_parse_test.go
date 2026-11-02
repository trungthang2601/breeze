package collectors

import "testing"

const dmidecodeTwoSticks = `# dmidecode 3.6
Getting SMBIOS data from sysfs.
SMBIOS 3.3.0 present.

Handle 0x0040, DMI type 17, 92 bytes
Memory Device
	Array Handle: 0x003F
	Total Width: 64 bits
	Size: 8 GB
	Form Factor: DIMM
	Locator: DIMM1
	Bank Locator: BANK 0
	Type: DDR4
	Speed: 3200 MT/s
	Manufacturer: Kingston
	Serial Number: 1A2B3C4D
	Part Number: KF432C16BB/8
	Configured Memory Speed: 2666 MT/s

Handle 0x0041, DMI type 17, 92 bytes
Memory Device
	Size: No Module Installed
	Locator: DIMM2

Handle 0x0042, DMI type 17, 40 bytes
Memory Device
	Size: 8192 MB
	Locator: ChannelB-DIMM0
	Speed: 3200 MHz
	Manufacturer: Samsung
	Serial Number: 00000000
	Part Number: M378A1K43EB2-CWE
`

func TestParseDmidecodeMemory(t *testing.T) {
	got := parseDmidecodeMemory(dmidecodeTwoSticks)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (%+v)", len(got), got)
	}
	if got[0].Slot != "DIMM1" || got[0].CapacityMB != 8192 || got[0].SpeedMHz != 2666 || got[0].SerialNumber != "1A2B3C4D" || got[0].PartNumber != "KF432C16BB/8" {
		t.Fatalf("stick 1 = %+v", got[0])
	}
	if got[1].Slot != "ChannelB-DIMM0" || got[1].CapacityMB != 8192 || got[1].SpeedMHz != 3200 || got[1].SerialNumber != "" {
		t.Fatalf("stick 2 = %+v", got[1])
	}
	if parseDmidecodeMemory("") != nil {
		t.Fatal("empty output should give nil")
	}
}

func TestParseLsblkDisks(t *testing.T) {
	modern := []byte(`{"blockdevices":[
		{"name":"nvme0n1","model":"Samsung SSD 980 500GB","serial":"S64DNX0R123456","size":500107862016,"rota":false,"tran":"nvme","type":"disk"},
		{"name":"sda","model":"ST1000DM010-2EP102","serial":"ZN1ABCDE","size":1000204886016,"rota":true,"tran":"sata","type":"disk"},
		{"name":"sdb","model":"USB Flash","serial":"X","size":32000000000,"rota":false,"tran":"usb","type":"disk"},
		{"name":"loop0","model":null,"serial":null,"size":100000000000,"rota":false,"tran":null,"type":"loop"},
		{"name":"sr0","model":"DVD","serial":null,"size":1073741312,"rota":true,"tran":"sata","type":"rom"}
	]}`)
	got := parseLsblkDisks(modern)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2 (%+v)", len(got), got)
	}
	if got[0].SizeGB != 500 || got[0].MediaType != "SSD" || got[0].BusType != "NVMe" || got[0].SerialNumber != "S64DNX0R123456" {
		t.Fatalf("nvme = %+v", got[0])
	}
	if got[1].SizeGB != 1000 || got[1].MediaType != "HDD" || got[1].BusType != "SATA" {
		t.Fatalf("hdd = %+v", got[1])
	}

	// Older lsblk: numbers and booleans as strings.
	old := []byte(`{"blockdevices":[{"name":"sda","model":"KINGSTON SA400S37240G","serial":"50026B7782A1B2C3","size":"240057409536","rota":"0","tran":"sata","type":"disk"}]}`)
	got = parseLsblkDisks(old)
	if len(got) != 1 || got[0].SizeGB != 240 || got[0].MediaType != "SSD" {
		t.Fatalf("old lsblk = %+v", got)
	}
	if parseLsblkDisks([]byte("not json")) != nil {
		t.Fatal("bad json should give nil")
	}
}

//go:build linux

package desktop

import (
	"errors"
	"fmt"
	"image"
	"sync"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// linuxCapturer mirrors an X11 session over the wire (no CGO). All state is
// per-instance so concurrent capturers (WS + WebRTC, screenshot borrows,
// monitor switch, cursor loop) never share or destroy each other's connection.
type linuxCapturer struct {
	config CaptureConfig

	mu   sync.Mutex
	conn *x11.Conn

	cursor      *x11.CursorTracker
	cursorShape atomic.Value // string (CSS cursor)

	// region is the selected monitor on a multi-monitor X screen;
	// nil means capture the whole root window.
	region *x11.MonitorGeom
}

// newPlatformCapturer creates a new Linux screen capturer. It resolves the
// display target itself so standalone tool/probe paths (which never call
// through a session that has already resolved a target) work unmodified.
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	target, err := x11.SelectX11Target()
	if err != nil {
		return nil, mapResolveErr(err)
	}
	conn, err := x11.Open(target)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrDisplayNotFound, err)
	}
	c := &linuxCapturer{config: config, conn: conn}
	c.selectRegion()
	// Cursor tracker is best-effort; capture still works without it.
	if ct, cerr := x11.NewCursorTracker(target); cerr == nil {
		c.cursor = ct
	}
	c.cursorShape.Store("default")
	return c, nil
}

func mapResolveErr(err error) error {
	switch {
	case errors.Is(err, x11.ErrWaylandUnsupported):
		return fmt.Errorf("%w: wayland session not supported", ErrNotSupported)
	default:
		return fmt.Errorf("%w: %v", ErrDisplayNotFound, err)
	}
}

// Capture returns a frame of the selected monitor (or the whole X screen when
// it has a single monitor) as image.RGBA whose Pix is BGRX (see IsBGRA).
func (c *linuxCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil, ErrNoActiveSession
	}
	pix, w, h, err := c.conn.CaptureBGRX()
	if err != nil {
		return nil, err
	}
	if r := c.region; r != nil {
		if r.X+r.Width > w || r.Y+r.Height > h {
			// Layout changed (xrandr / hotplug): re-resolve for the next frame.
			c.selectRegionLocked()
			return nil, fmt.Errorf("monitor region %dx%d+%d+%d outside screen %dx%d", r.Width, r.Height, r.X, r.Y, w, h)
		}
		// Crop the selected monitor out of the fast SHM full-screen grab;
		// the non-SHM GetImage region path is far too slow (~3 fps at 1080p).
		rowBytes := r.Width * 4
		srcStride := w * 4
		out := make([]byte, rowBytes*r.Height)
		for row := 0; row < r.Height; row++ {
			src := (r.Y+row)*srcStride + r.X*4
			copy(out[row*rowBytes:(row+1)*rowBytes], pix[src:src+rowBytes])
		}
		return &image.RGBA{Pix: out, Stride: rowBytes, Rect: image.Rect(0, 0, r.Width, r.Height)}, nil
	}
	img := &image.RGBA{
		Pix:    make([]byte, len(pix)),
		Stride: w * 4,
		Rect:   image.Rect(0, 0, w, h),
	}
	copy(img.Pix, pix) // SHM buffer is reused next call — must copy
	return img, nil
}

// CaptureRegion captures a specific region of the screen.
func (c *linuxCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return nil, ErrNoActiveSession
	}
	pix, err := c.conn.CaptureRegionBGRX(x, y, width, height)
	if err != nil {
		return nil, err
	}
	img := &image.RGBA{Pix: pix, Stride: width * 4, Rect: image.Rect(0, 0, width, height)}
	return img, nil
}

// GetScreenBounds returns the screen dimensions.
func (c *linuxCapturer) GetScreenBounds() (int, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return 0, 0, ErrNoActiveSession
	}
	if r := c.region; r != nil {
		return r.Width, r.Height, nil
	}
	w, h := c.conn.Bounds()
	return w, h, nil
}

// Close releases the capture connection and the cursor tracker's connection.
func (c *linuxCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cursor != nil {
		c.cursor.Close()
		c.cursor = nil
	}
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

// IsBGRA reports that Capture()'s Pix holds BGRX, not RGBA — the encoder skips
// the conversion. (X ZPixmap on little-endian amd64/arm64 is BGRX.)
func (c *linuxCapturer) IsBGRA() bool { return true }

// CursorPosition polls the cursor on the dedicated connection and updates shape.
func (c *linuxCapturer) CursorPosition() (x, y int32, visible bool) {
	c.mu.Lock()
	ct := c.cursor
	c.mu.Unlock()
	if ct == nil {
		return 0, 0, false
	}
	px, py, name, ok := ct.Poll()
	if !ok {
		return 0, 0, false
	}
	c.cursorShape.Store(mapX11CursorToCSS(name))
	return int32(px), int32(py), true
}

// CursorShape implements CursorShapeProvider. The shape is updated as a side
// effect of CursorPosition(), so callers should call CursorPosition first.
func (c *linuxCapturer) CursorShape() string {
	if v, ok := c.cursorShape.Load().(string); ok {
		return v
	}
	return "default"
}

var _ ScreenCapturer = (*linuxCapturer)(nil)
var _ BGRAProvider = (*linuxCapturer)(nil)
var _ CursorProvider = (*linuxCapturer)(nil)
var _ CursorShapeProvider = (*linuxCapturer)(nil)

func (c *linuxCapturer) selectRegion() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.selectRegionLocked()
}

// selectRegionLocked crops capture to config.DisplayIndex when the X screen
// spans several monitors, so the frame matches the monitor the viewer picked
// (input already uses the same monitor via applyDisplayOffset) and stays
// within encoder limits (e.g. OpenH264 rejects a 5760x2160 combined screen).
// Monitor order matches ListMonitors.
func (c *linuxCapturer) selectRegionLocked() {
	c.region = nil
	if c.conn == nil {
		return
	}
	w, h := c.conn.Bounds()
	geoms, err := x11.Monitors(c.conn.XConn(), c.conn.Root(), w, h)
	if err != nil || len(geoms) < 2 {
		return
	}
	idx := c.config.DisplayIndex
	if idx < 0 || idx >= len(geoms) {
		idx = 0
	}
	g := geoms[idx]
	if g.Width <= 0 || g.Height <= 0 || g.X < 0 || g.Y < 0 || g.X+g.Width > w || g.Y+g.Height > h {
		return
	}
	c.region = &g
}

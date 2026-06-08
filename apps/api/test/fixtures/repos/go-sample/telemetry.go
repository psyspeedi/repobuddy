package sample

import "time"

type TelemetryEvent struct {
	Name      string
	Payload   map[string]any
	Timestamp time.Time
}

func LogEvent(name string, payload map[string]any) {
	event := TelemetryEvent{Name: name, Payload: payload, Timestamp: time.Now()}
	_ = event
}

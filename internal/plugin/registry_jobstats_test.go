package plugin

import (
	"errors"
	"testing"
	"time"
)

func TestJobStatsWindowAndSorting(t *testing.T) {
	r := &Registry{}
	now := time.Unix(1800000000, 0)
	r.registerJobStats("im", "IM", Job{Name: "pull", Every: time.Second})
	r.registerJobStats("im", "IM", Job{Name: "other"})
	r.recordJobFinish("im", "pull", now.Add(-time.Hour), now.Add(-time.Hour), nil, false)
	r.recordJobFinish("im", "pull", now.Add(-time.Second), now, nil, false)
	r.recordJobFinish("im", "pull", now, now, errors.New("failed"), false)
	r.recordJobFinish("im", "pull", now, now, errors.New("canceled"), true)
	rows := r.jobStatsAt(now)
	if len(rows) != 2 || rows[0].Name != "pull" || rows[0].Total != 3 || rows[0].Success != 1 || rows[0].Failed != 1 || rows[0].Canceled != 1 {
		t.Fatalf("unexpected: %+v", rows)
	}
	if rows[0].LastError != "failed" {
		t.Fatalf("error lost: %+v", rows[0])
	}
	rows = r.jobStatsAt(now.Add(time.Hour))
	for _, row := range rows {
		if row.Total != 0 {
			t.Fatalf("did not expire: %+v", row)
		}
	}
}

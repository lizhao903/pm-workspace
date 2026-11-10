// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

package api

import (
	"context"

	"github.com/lizhao903/pm-workspace/internal/domain"
)

// 今日聚合的替身：口径（和 counts 一致、只看 review 任务）在 sqlite 那边测，
// 这里只回一份形状正确的空卡片，保证 handler 能跑通。
func (f *fakeStore) Today(context.Context, string) (*domain.Today, error) {
	cards := []*domain.TodayCard{}
	for i, k := range []string{domain.TodayCardReview, domain.TodayCardOverdue, domain.TodayCardDueToday} {
		cards = append(cards, &domain.TodayCard{Key: k, Order: (i + 1) * 10, Items: []*domain.Object{}})
	}
	cards = append(cards, &domain.TodayCard{Key: domain.TodayCardRunning, Order: 40, Items: []*domain.TodayRun{}})
	return &domain.Today{Cards: cards}, nil
}

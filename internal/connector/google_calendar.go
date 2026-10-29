package connector

// Google 日历连接器（CONN-01e2）：范围 calendar.readonly 加 calendar.events。
// 工具：列日历、查日程（只读），新建日程（写，默认需确认）。OAuth 和连通测试复用 google.go。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GoogleCalendarTool 是 Google 日历连接器的 key，同原型 gcal。
const GoogleCalendarTool = "gcal"

const (
	calendarReadScope   = "https://www.googleapis.com/auth/calendar.readonly"
	calendarEventsScope = "https://www.googleapis.com/auth/calendar.events"
	googleCalendarAPI   = "https://www.googleapis.com/calendar/v3"

	calendarPageDefault = 50
	calendarPageMax     = 250
	calendarTextMax     = 8000
	calendarAttendeeMax = 100
)

// calendarIDRe 认 primary、邮箱形式的日历 id 和节假日日历（带 #）。
var calendarIDRe = regexp.MustCompile(`^[A-Za-z0-9._@#+-]{1,256}$`)

// GoogleCalendarEndpoints 是日历用的地址：Google 共用的那几个加日历 v3 的根（不带末尾 /）。
// 正式登记用零值，测试换成本机假服务的地址。
type GoogleCalendarEndpoints struct {
	GoogleEndpoints
	CalendarAPI string
}

func (e GoogleCalendarEndpoints) withDefaults() GoogleCalendarEndpoints {
	e.GoogleEndpoints = e.GoogleEndpoints.withDefaults()
	if e.CalendarAPI == "" {
		e.CalendarAPI = googleCalendarAPI
	}
	e.CalendarAPI = strings.TrimRight(e.CalendarAPI, "/")
	return e
}

// calendarTools 是日历的工具目录：新建日程是写工具，默认需确认。
func calendarTools() []ToolDef {
	return []ToolDef{
		{Name: "list_calendars", Desc: "列出能看到的日历，参数 {page_size?, page_token?}", Write: false},
		{Name: "list_events", Desc: "查某段时间的日程，参数 {calendar_id?（默认主日历）, time_min?, time_max?（RFC3339）, query?, page_size?, page_token?}", Write: false},
		{Name: "create_event", Desc: "新建日程，有参与人时发邀请，参数 {summary, start, end（RFC3339 或全天的 YYYY-MM-DD）, calendar_id?, time_zone?, description?, location?, attendees?（邮箱数组）}", Write: true},
	}
}

// GoogleCalendar 是 Google 日历连接器的定义。e 为零值时用正式的 Google 地址，测试传本机假服务的地址。
func GoogleCalendar(e GoogleCalendarEndpoints) Def {
	e = e.withDefaults()
	return Def{
		Tool: GoogleCalendarTool, Label: "Google 日历", Category: "office", Color: "#1a73e8",
		Desc: "查日程、建日程", Auth: []AuthMode{AuthOAuth2},
		Fields: googleFields(),
		OAuth:  googleOAuth(e.GoogleEndpoints, calendarReadScope, calendarEventsScope),
		Tools:  calendarTools(),
		Test:   googleTest(e.GoogleEndpoints),
		Call: func(ctx context.Context, cfg Config, tool string, args json.RawMessage) (string, error) {
			return calendarCall(ctx, e, cfg, tool, args)
		},
	}
}

type calendarArgs struct {
	CalendarID  string   `json:"calendar_id"`
	TimeMin     string   `json:"time_min"`
	TimeMax     string   `json:"time_max"`
	Query       string   `json:"query"`
	PageSize    int      `json:"page_size"`
	PageToken   string   `json:"page_token"`
	Summary     string   `json:"summary"`
	Description string   `json:"description"`
	Location    string   `json:"location"`
	Start       string   `json:"start"`
	End         string   `json:"end"`
	TimeZone    string   `json:"time_zone"`
	Attendees   []string `json:"attendees"`
}

// calTime 是日历接口的时间：全天日程用 date，否则 dateTime。
type calTime struct {
	Date     string `json:"date,omitempty"`
	DateTime string `json:"dateTime,omitempty"`
	TimeZone string `json:"timeZone,omitempty"`
}

func (t calTime) text() string {
	if t.Date != "" {
		return t.Date
	}
	return t.DateTime
}

type calPerson struct {
	Email          string `json:"email"`
	DisplayName    string `json:"displayName,omitempty"`
	ResponseStatus string `json:"responseStatus,omitempty"`
	Self           bool   `json:"self,omitempty"`
}

func (p calPerson) text() string {
	s := p.Email
	if p.DisplayName != "" {
		s = p.DisplayName + " <" + p.Email + ">"
	}
	if p.ResponseStatus != "" {
		s += " (" + p.ResponseStatus + ")"
	}
	return s
}

// calEvent 是日历返回的日程；回给模型时换成 calEventOut 的下划线命名。
type calEvent struct {
	ID          string      `json:"id"`
	Status      string      `json:"status"`
	Summary     string      `json:"summary"`
	Description string      `json:"description"`
	Location    string      `json:"location"`
	Start       calTime     `json:"start"`
	End         calTime     `json:"end"`
	HTMLLink    string      `json:"htmlLink"`
	Organizer   calPerson   `json:"organizer"`
	Attendees   []calPerson `json:"attendees"`
}

type calEventOut struct {
	ID          string   `json:"id"`
	Summary     string   `json:"summary"`
	Start       string   `json:"start"`
	End         string   `json:"end"`
	AllDay      bool     `json:"all_day"`
	Status      string   `json:"status,omitempty"`
	Description string   `json:"description,omitempty"`
	Location    string   `json:"location,omitempty"`
	Organizer   string   `json:"organizer,omitempty"`
	Attendees   []string `json:"attendees,omitempty"`
	HTMLLink    string   `json:"html_link,omitempty"`
}

func (v calEvent) out() calEventOut {
	o := calEventOut{ID: v.ID, Summary: v.Summary, Start: v.Start.text(), End: v.End.text(), AllDay: v.Start.Date != "",
		Status: v.Status, Description: v.Description, Location: v.Location, HTMLLink: v.HTMLLink}
	if v.Organizer.Email != "" {
		o.Organizer = calPerson{Email: v.Organizer.Email, DisplayName: v.Organizer.DisplayName}.text()
	}
	for _, p := range v.Attendees {
		o.Attendees = append(o.Attendees, p.text())
	}
	return o
}

func calendarCall(ctx context.Context, e GoogleCalendarEndpoints, cfg Config, tool string, raw json.RawMessage) (string, error) {
	var a calendarArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return "", fmt.Errorf("参数不是合法的 JSON 对象：%w", err)
	}
	var out any
	var err error
	switch tool {
	case "list_calendars":
		out, err = calendarListCalendars(ctx, e, cfg, a)
	case "list_events":
		out, err = calendarListEvents(ctx, e, cfg, a)
	case "create_event":
		out, err = calendarCreateEvent(ctx, e, cfg, a)
	default:
		return "", fmt.Errorf("unknown tool %s", tool)
	}
	if err != nil {
		return "", err
	}
	// 结果给模型看，< > & 不转义
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

func calendarPageSize(n int) string {
	if n <= 0 {
		n = calendarPageDefault
	}
	return fmt.Sprint(min(n, calendarPageMax))
}

// calendarPath 校验日历 id 并拼出 /calendars/<id>，默认主日历。
func calendarPath(e GoogleCalendarEndpoints, id string) (string, error) {
	if id == "" {
		id = "primary"
	}
	if !calendarIDRe.MatchString(id) {
		return "", errors.New("calendar_id 不合法")
	}
	return e.CalendarAPI + "/calendars/" + url.PathEscape(id), nil
}

func calendarListCalendars(ctx context.Context, e GoogleCalendarEndpoints, cfg Config, a calendarArgs) (any, error) {
	q := url.Values{"maxResults": {calendarPageSize(a.PageSize)}}
	if a.PageToken != "" {
		q.Set("pageToken", a.PageToken)
	}
	var res struct {
		NextPageToken string `json:"nextPageToken"`
		Items         []struct {
			ID          string `json:"id"`
			Summary     string `json:"summary"`
			Description string `json:"description"`
			Primary     bool   `json:"primary"`
			AccessRole  string `json:"accessRole"`
			TimeZone    string `json:"timeZone"`
		} `json:"items"`
	}
	if err := googleGet(ctx, cfg, e.CalendarAPI+"/users/me/calendarList", q, &res); err != nil {
		return nil, err
	}
	cals := make([]map[string]any, 0, len(res.Items))
	for _, c := range res.Items {
		m := map[string]any{"id": c.ID, "summary": c.Summary, "primary": c.Primary, "access_role": c.AccessRole}
		if c.TimeZone != "" {
			m["time_zone"] = c.TimeZone
		}
		if c.Description != "" {
			m["description"] = c.Description
		}
		cals = append(cals, m)
	}
	out := map[string]any{"calendars": cals}
	if res.NextPageToken != "" {
		out["next_page_token"] = res.NextPageToken
	}
	return out, nil
}

func calendarListEvents(ctx context.Context, e GoogleCalendarEndpoints, cfg Config, a calendarArgs) (any, error) {
	base, err := calendarPath(e, a.CalendarID)
	if err != nil {
		return nil, err
	}
	// 不给开始时间就从现在查起；展开重复日程，按开始时间排
	q := url.Values{"singleEvents": {"true"}, "orderBy": {"startTime"}, "maxResults": {calendarPageSize(a.PageSize)}}
	tmin, tmax := strings.TrimSpace(a.TimeMin), strings.TrimSpace(a.TimeMax)
	if tmin == "" {
		tmin = time.Now().UTC().Format(time.RFC3339)
	}
	for _, p := range []struct{ key, val, name string }{{"timeMin", tmin, "time_min"}, {"timeMax", tmax, "time_max"}} {
		if p.val == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339, p.val); err != nil {
			return nil, fmt.Errorf("%s 要是 RFC3339 时间，如 2026-10-29T09:00:00+08:00", p.name)
		}
		q.Set(p.key, p.val)
	}
	if s := strings.TrimSpace(a.Query); s != "" {
		q.Set("q", s)
	}
	if a.PageToken != "" {
		q.Set("pageToken", a.PageToken)
	}
	var res struct {
		NextPageToken string     `json:"nextPageToken"`
		TimeZone      string     `json:"timeZone"`
		Items         []calEvent `json:"items"`
	}
	if err := googleGet(ctx, cfg, base+"/events", q, &res); err != nil {
		return nil, err
	}
	events := make([]calEventOut, 0, len(res.Items))
	for _, v := range res.Items {
		events = append(events, v.out())
	}
	out := map[string]any{"events": events}
	if res.TimeZone != "" {
		out["time_zone"] = res.TimeZone
	}
	if res.NextPageToken != "" {
		out["next_page_token"] = res.NextPageToken
	}
	return out, nil
}

// calendarWhen 把 start、end 的文本换成日历接口的时间：YYYY-MM-DD 是全天，否则要 RFC3339。
func calendarWhen(s, name, tz string) (calTime, time.Time, error) {
	s = strings.TrimSpace(s)
	if d, err := time.Parse(time.DateOnly, s); err == nil {
		return calTime{Date: s}, d, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return calTime{}, time.Time{}, fmt.Errorf("%s 要是 RFC3339 时间（如 2026-10-29T09:00:00+08:00）或全天的 YYYY-MM-DD", name)
	}
	return calTime{DateTime: s, TimeZone: tz}, t, nil
}

func calendarCreateEvent(ctx context.Context, e GoogleCalendarEndpoints, cfg Config, a calendarArgs) (any, error) {
	base, err := calendarPath(e, a.CalendarID)
	if err != nil {
		return nil, err
	}
	summary := strings.TrimSpace(a.Summary)
	if summary == "" {
		return nil, errors.New("summary 必填")
	}
	if len([]rune(a.Description)) > calendarTextMax || len([]rune(summary)) > calendarTextMax || len([]rune(a.Location)) > calendarTextMax {
		return nil, fmt.Errorf("summary、description、location 各最多 %d 字", calendarTextMax)
	}
	tz := strings.TrimSpace(a.TimeZone)
	if tz != "" {
		if _, err := time.LoadLocation(tz); err != nil || tz == "Local" {
			return nil, errors.New("time_zone 要是 IANA 时区名，如 Asia/Shanghai")
		}
	}
	start, st, err := calendarWhen(a.Start, "start", tz)
	if err != nil {
		return nil, err
	}
	end, et, err := calendarWhen(a.End, "end", tz)
	if err != nil {
		return nil, err
	}
	if (start.Date == "") != (end.Date == "") {
		return nil, errors.New("start 和 end 要么都是全天日期，要么都是时间")
	}
	if !et.After(st) {
		return nil, errors.New("end 要晚于 start（全天日程的 end 是结束日的下一天）")
	}
	if len(a.Attendees) > calendarAttendeeMax {
		return nil, fmt.Errorf("attendees 最多 %d 个", calendarAttendeeMax)
	}
	body := map[string]any{"summary": summary, "start": start, "end": end}
	if a.Description != "" {
		body["description"] = a.Description
	}
	if a.Location != "" {
		body["location"] = a.Location
	}
	var people []calPerson
	seen := map[string]bool{}
	for _, m := range a.Attendees {
		m = strings.TrimSpace(m)
		if !strings.Contains(m, "@") || strings.ContainsAny(m, " <>,;") {
			return nil, fmt.Errorf("参与人 %q 不是邮箱", m)
		}
		if k := strings.ToLower(m); !seen[k] {
			seen[k] = true
			people = append(people, calPerson{Email: m})
		}
	}
	// 有参与人时发邀请（原型「建日程并发邀请」），没有就不发
	send := "none"
	if len(people) > 0 {
		body["attendees"] = people
		send = "all"
	}
	var v calEvent
	if err := calendarPost(ctx, cfg, base+"/events", url.Values{"sendUpdates": {send}}, body, &v); err != nil {
		return nil, err
	}
	return v.out(), nil
}

// calendarPost 带令牌 POST JSON 到日历接口，按 JSON 解码进 out。错误同 googleFetch，不带请求头。
func calendarPost(ctx context.Context, cfg Config, rawURL string, q url.Values, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	if len(q) > 0 {
		rawURL += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.AccessToken())
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxGoogleBody+1))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("Google 返回 %d：%s", resp.StatusCode, googleErrMessage(body))
	}
	if len(body) > maxGoogleBody {
		return fmt.Errorf("Google 返回的内容超过 %d MB", maxGoogleBody>>20)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("Google 返回的不是合法 JSON：%w", err)
	}
	return nil
}

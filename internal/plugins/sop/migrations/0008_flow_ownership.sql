ALTER TABLE sop_flows ADD COLUMN ownership TEXT NOT NULL DEFAULT 'nobuild-in' CHECK (ownership IN ('buildin', 'nobuild-in'));

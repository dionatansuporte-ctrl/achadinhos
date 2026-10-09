CREATE TABLE "GroupMemberEvent" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "member" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GroupMemberEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupMemberEvent_groupId_member_kind_at_key" ON "GroupMemberEvent"("groupId", "member", "kind", "at");
CREATE INDEX "GroupMemberEvent_at_idx" ON "GroupMemberEvent"("at");

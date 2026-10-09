CREATE TABLE "GroupInviteSent" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "who" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupInviteSent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupInviteSent_groupId_who_key" ON "GroupInviteSent"("groupId", "who");

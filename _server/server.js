require('dotenv').config();
global.WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3111;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// Load routes
// REMOVED Phase7: require("./routes/sb-url-rewrite.system")(app);
require('./routes/get-student-ttkb.baihoc')(app);
require('./routes/ttkb-zalo-cron.baihoc')(app);
require('./routes/room-size-batch.watch')(app);
require('./routes/student-alerts-cron.watch')(app);
require('./routes/remind-duties-cron.duty')(app);
require('./routes/learn-today-data.notice')(app);
require('./routes/learn-joins-today.notice')(app);
require('./routes/learn-notes-today.notice')(app);
require('./routes/learn-today-boot.notice')(app);
require('./routes/check-exceeded-students.notice')(app);
require('./routes/check-unjoined-students.notice')(app);
require('./routes/remind-unnoted-cron.message')(app);
require('./routes/recap-messages-cron.message')(app);
require('./routes/process-recordings-cron.calling')(app);
require('./routes/remind-unconfirmed-cron.meeting')(app);
require('./routes/breakout-rooms.meeting')(app);
require('./routes/tiep-hv-meeting.meeting')(app);
require('./routes/save-temp-substitute.meeting')(app);
require('./routes/notify-unmatched-students-cron.meeting')(app);
require('./routes/status.system')(app);
require('./routes/device-ping.baihoc')(app);
require('./routes/lesson-ids.baihoc')(app);
require('./routes/profile.baihoc')(app);
require('./routes/gdoc-html.baihoc')(app);
require('./routes/lesson-types.baihoc')(app);
require('./routes/student-lookup.baihoc')(app);
require('./routes/supabase-credentials.baihoc')(app);
require('./routes/lessons-next.baihoc')(app);
require('./routes/email-suggest.baihoc')(app);
require('./routes/lesson-submissions.baihoc')(app);
require('./routes/device-check.baihoc')(app);
require('./routes/tts.baihoc')(app);
require('./routes/unapproved-by-email.baihoc')(app);
require('./routes/send-zalo.baihoc')(app);
require('./routes/gt.baihoc')(app);
require('./routes/mw.baihoc')(app);
require('./routes/unapproved-all.baihoc')(app);
require('./routes/zalo-status.baihoc')(app);
require('./routes/presign-wasabi.baihoc')(app);
require('./routes/save-submission.baihoc')(app);
require('./routes/approve-submission.baihoc')(app);
require('./routes/approved-lessons.baihoc')(app);
require('./routes/uu-tien-settings.baihoc')(app);
require('./routes/meetingsfrommeetingcontent.meeting')(app);
require('./routes/offdays-range.meeting')(app);
require('./routes/student-note.meeting')(app);
require('./routes/request-change.meeting')(app);
require('./routes/check-role.meeting')(app);
require('./routes/tiep-hv-all.meeting')(app);
require('./routes/unconfirmed-teachers-count.meeting')(app);
require('./routes/editcalendar.meeting')(app);
require('./routes/confirm-student-day.meeting')(app);
require('./routes/userroles-search.meeting')(app);
require('./routes/get-working-teachers-for-date.meeting')(app);
require('./routes/upcoming-impacted-students.meeting')(app);
require('./routes/unmatched-students.meeting')(app);
require('./routes/verify-security-key.meeting')(app);
require('./routes/check-week-confirmation.meeting')(app);
require('./routes/get-teacher-ranges.meeting')(app);
require('./routes/confirm-free-hours.meeting')(app);

// --- Meeting Batch 2 (migrated from Netlify) ---
require("./routes/addmeeting.meeting")(app);
require("./routes/addworkmeeting.meeting")(app);
require("./routes/assigned-owners-today.meeting")(app);
require("./routes/confirm-week.meeting")(app);
require("./routes/deletecalendar.meeting")(app);
require("./routes/displaymeetinglink.meeting")(app);
require("./routes/get-working-teachers.meeting")(app);
require("./routes/impacted-students.meeting")(app);
require("./routes/meetinglink-by-email.meeting")(app);
require("./routes/meetinglinks-search.meeting")(app);
require("./routes/my-students.meeting")(app);
require("./routes/offday.meeting")(app);
require("./routes/offdays-crud.meeting")(app);
require("./routes/save-student-transfer.meeting")(app);
require("./routes/sync-meeting-offdays.meeting")(app);
require("./routes/teacher-by-email.meeting")(app);
require("./routes/teacher-shifts.meeting")(app);
require("./routes/teachers-search.meeting")(app);


// --- RealtimeReport Batch 1 ---
require("./routes/get-user-role.realtimereport")(app);
require("./routes/get-user-names.realtimereport")(app);
require("./routes/get-doc-library.realtimereport")(app);
require("./routes/get-task-catalog.realtimereport")(app);
require("./routes/check-active-task.realtimereport")(app);
require("./routes/check-daily-limit.realtimereport")(app);
require("./routes/get-video-durations.realtimereport")(app);
require("./routes/check-start-work.realtimereport")(app);
// --- RealtimeReport Batch 2 ---
require("./routes/check-task-limit.realtimereport")(app);
require("./routes/check-task-validity.realtimereport")(app);
require("./routes/check-ttkb-limits.realtimereport")(app);
require("./routes/check-schedule-day.realtimereport")(app);
require("./routes/check-shift-permission.realtimereport")(app);
require("./routes/check-knowledge-quiz.realtimereport")(app);
require("./routes/check-overdue-duties.realtimereport")(app);
require("./routes/get-my-work.realtimereport")(app);
require("./routes/get-student-history.realtimereport")(app);
require("./routes/get-student-week-ttkb.realtimereport")(app);
// --- RealtimeReport Batch 3 ---
require("./routes/get-students-on-leave.realtimereport")(app);
require("./routes/get-task-options.realtimereport")(app);
require("./routes/get-template-fields.realtimereport")(app);
require("./routes/get-today-links.realtimereport")(app);
require("./routes/get-admin-month-data.realtimereport")(app);
require("./routes/grant-extra-session.realtimereport")(app);
require("./routes/create-task.realtimereport")(app);
require("./routes/create-admin-task.realtimereport")(app);
require("./routes/create-ttkb.realtimereport")(app);
require("./routes/save-start-work.realtimereport")(app);
// --- RealtimeReport Batch 4 (FINAL) ---
require("./routes/end-work-shift.realtimereport")(app);
require("./routes/update-link.realtimereport")(app);
require("./routes/delete-work-row.realtimereport")(app);
require("./routes/delete-my-incomplete-task.realtimereport")(app);
require("./routes/work-comments.realtimereport")(app);
require("./routes/work-complaints.realtimereport")(app);
require("./routes/search-students.realtimereport")(app);
require("./routes/search-student-emails.realtimereport")(app);
require("./routes/interactive-next-lesson.realtimereport")(app);
require("./routes/rtr-supabase-credentials.realtimereport")(app);
require("./routes/rtr-presign-wasabi.realtimereport")(app);

// --- Bookshelf Routes ---
require("./routes/books-api.bookshelf")(app);
require("./routes/chapters-api.bookshelf")(app);
require("./routes/categories-api.bookshelf")(app);
require("./routes/levels-api.bookshelf")(app);
require("./routes/wordwise-api.bookshelf")(app);
require("./routes/wordwise-generate-background.bookshelf")(app);
require("./routes/word-lookup.bookshelf")(app);
require("./routes/mw-audio-api.bookshelf")(app);
require("./routes/presign-wasabi-bookshelf.bookshelf")(app);
require("./routes/supabase-credentials-bookshelf.bookshelf")(app);

// --- Baihoc Remaining Functions (migrated from Netlify) ---
require("./routes/device-approval-api.baihoc")(app);
require("./routes/device-grant.baihoc")(app);
require("./routes/device-remove.baihoc")(app);
require("./routes/device-request.baihoc")(app);
require("./routes/device-reset.baihoc")(app);
require("./routes/expired-status.baihoc")(app);
require("./routes/get-presigned-url.baihoc")(app);
require("./routes/grant-email.baihoc")(app);
require("./routes/grant-zalo-bypass.baihoc")(app);
require("./routes/lessons-redo-add.baihoc")(app);
require("./routes/mark-passed.baihoc")(app);
require("./routes/mark-viewed.baihoc")(app);
require("./routes/note-zalo-message.baihoc")(app);
require("./routes/reply-zalo-message.baihoc")(app);
require("./routes/student-alerts.baihoc")(app);
require("./routes/submissions-today.baihoc")(app);
require("./routes/uu-tien-level-exclusions.baihoc")(app);

// --- Round-Robin Routes ---
require("./routes/round-robin-status.baihoc")(app);
require("./routes/round-robin-mark.baihoc")(app);

// --- Quiz App Routes (migrated from Netlify) ---
require("./routes/quiz-credentials.quiz")(app);
require("./routes/quiz-create.quiz")(app);
require("./routes/quiz-delete.quiz")(app);
require("./routes/quiz-state.quiz")(app);
require("./routes/quiz-search-students.quiz")(app);
require("./routes/quiz-submissions-list.quiz")(app);
require("./routes/quiz-grant-extra-attempt.quiz")(app);
require("./routes/quiz-submission-get.quiz")(app);
require("./routes/quiz-presign-wasabi.quiz")(app);
require("./routes/quiz-emergency-submit.quiz")(app);

// --- Penalty Routes ---
require("./routes/pen-credentials.penalty")(app);
require("./routes/pen-get-penalty-data.penalty")(app);
require("./routes/pen-get-tieu-chi.penalty")(app);
require("./routes/pen-get-penalties.penalty")(app);
require("./routes/pen-delete-penalty.penalty")(app);
require("./routes/pen-delete-from-penalties.penalty")(app);

// --- LamLaiForm Routes ---
require("./routes/llf-credentials.lamlaiform")(app);

// --- StudentSubmissions Routes ---
require("./routes/ss-credentials.studentsubmissions")(app);
require("./routes/ss-get-user-names.studentsubmissions")(app);
require("./routes/ss-get-student-teachers.studentsubmissions")(app);
require("./routes/ss-students-not-submitted-today.studentsubmissions")(app);
require("./routes/ss-get-submission.studentsubmissions")(app);

// --- HocPhi Routes ---
require("./routes/hp-programs.hocphi")(app);

// --- Screen Recorder Routes (migrated from Netlify) ---
require("./routes/rec-credentials.recorder")(app);
require("./routes/rec-complete.recorder")(app);
require("./routes/rec-approve-oversized.recorder")(app);
require("./routes/rec-presigned-url.recorder")(app);
require("./routes/rec-part-url.recorder")(app);
require("./routes/rec-start-multipart.recorder")(app);
require("./routes/rec-list-parts.recorder")(app);
require("./routes/rec-abort-multipart.recorder")(app);
require("./routes/rec-complete-multipart.recorder")(app);
require("./routes/rec-slot.recorder")(app);
require("./routes/rec-slot-beacon.recorder")(app);
require("./routes/rec-client-log.recorder")(app);
require("./routes/rec-cleanup-orphaned.recorder")(app);
require("./routes/rec-health-digest.recorder")(app);

// (duplicate rec-client-log removed)

// --- Message App Routes (migrated from Netlify) ---
require("./routes/login.message")(app);
require("./routes/messages.message")(app);
require("./routes/mark-noted.message")(app);
require("./routes/delete-message.message")(app);
require("./routes/ignore-message.message")(app);
require("./routes/complete-task.message")(app);
require("./routes/zalo-create-task.message")(app);
require("./routes/get-role.message")(app);
require("./routes/get-sender-names.message")(app);
require("./routes/counters.message")(app);
require("./routes/unnoted-count.message")(app);
require("./routes/search-by-id.message")(app);
require("./routes/sent-messages.message")(app);
require("./routes/suggest-students.message")(app);
require("./routes/search-teacher-email.message")(app);
require("./routes/get-break-students.message")(app);
require("./routes/get-working-teachers.message")(app);
require("./routes/get-response-stats.message")(app);
require("./routes/get-ignored-logs.message")(app);
require("./routes/create-template.message")(app);
require("./routes/create-penalty.message")(app);
require("./routes/delete-status.message")(app);
require("./routes/bulk-send-zalo.message")(app);
require("./routes/bulk-send-zalo-background.message")(app);
require("./routes/assign-duty.message")(app);
require("./routes/get-tasks.message")(app);


// --- Duty App Routes (migrated from Netlify) ---
require("./routes/duty-assign.duty")(app);
require("./routes/duty-complete.duty")(app);
require("./routes/duty-delete.duty")(app);
require("./routes/duty-update.duty")(app);
require("./routes/duty-load.duty")(app);
require("./routes/duty-load-comments.duty")(app);
require("./routes/duty-add-comment.duty")(app);
require("./routes/duty-load-teachers.duty")(app);
require("./routes/duty-search-teachers.duty")(app);
require("./routes/duty-presign-wasabi.duty")(app);
require("./routes/duty-supabase-credentials.duty")(app);
require("./routes/duty-load-department-emails.duty")(app);
require("./routes/duty-complain.duty")(app);
// (duplicate rec-client-log removed)

// --- Calendar App Routes (migrated from Netlify) ---
require("./routes/cal-get-teacher-ranges.calendar")(app);
require("./routes/cal-presign-wasabi.calendar")(app);
require("./routes/cal-search-students.calendar")(app);
require("./routes/cal-search-teachers.calendar")(app);
require("./routes/cal-supabase-credentials.calendar")(app);
require("./routes/check-level-assignment.calendar")(app);
require("./routes/compute-start-delta.calendar")(app);
require("./routes/delete-student-schedules.calendar")(app);
require("./routes/delete-teacher.calendar")(app);
require("./routes/find-matching-teachers.calendar")(app);
require("./routes/find-suitable-teachers.calendar")(app);
require("./routes/get-active-students.calendar")(app);
require("./routes/get-teacher-board.calendar")(app);
require("./routes/get-user-email.calendar")(app);
require("./routes/learn-complete.calendar")(app);
require("./routes/learn-short-report.calendar")(app);
require("./routes/learn-status-report.calendar")(app);
require("./routes/load-student-editor.calendar")(app);
require("./routes/load-student-schedules.calendar")(app);
require("./routes/planner-data.calendar")(app);
require("./routes/reassign-after-teacher-change.calendar")(app);
require("./routes/reassign-teacher.calendar")(app);
require("./routes/save-student-schedule.calendar")(app);
require("./routes/save-teacher-availability.calendar")(app);
require("./routes/save-teacher-schedule.calendar")(app);
require("./routes/set-breakout-teacher-cal.calendar")(app);
require("./routes/set-teacher.calendar")(app);
require("./routes/student-minutes.calendar")(app);
require("./routes/teacher-blocks-add.calendar")(app);
require("./routes/teacher-blocks-clear-range.calendar")(app);
require("./routes/teacher-blocks-delete.calendar")(app);
require("./routes/teacher-blocks-set-student.calendar")(app);
require("./routes/teacher-blocks-update.calendar")(app);
require("./routes/teachers-list.calendar")(app);
require("./routes/update-teacher-shift.calendar")(app);
require("./routes/user-role-suggest.calendar")(app);

// --- Giao Bai App Routes (migrated from Netlify) ---
require("./routes/gb-add-book-exclusion.giaobai")(app);
require("./routes/gb-add-lesson-exclusion.giaobai")(app);
require("./routes/gb-all-students-books.giaobai")(app);
require("./routes/gb-assign-book.giaobai")(app);
require("./routes/gb-books-list.giaobai")(app);
require("./routes/gb-books-list-agg.giaobai")(app);
require("./routes/gb-cap-lop-list.giaobai")(app);
require("./routes/gb-class-names-secure.giaobai")(app);
require("./routes/gb-completed-lessons.giaobai")(app);
require("./routes/gb-create-lessons.giaobai")(app);
require("./routes/gb-delete-book.giaobai")(app);
require("./routes/gb-delete-lesson.giaobai")(app);
require("./routes/gb-lesson-today-save.giaobai")(app);
require("./routes/gb-lessons-by-book.giaobai")(app);
require("./routes/gb-list-student-books.giaobai")(app);
require("./routes/gb-pause-book.giaobai")(app);
require("./routes/gb-prioritize-list.giaobai")(app);
require("./routes/gb-prioritize-save.giaobai")(app);
require("./routes/gb-remove-book-exclusion.giaobai")(app);
require("./routes/gb-search-emails.giaobai")(app);
require("./routes/gb-set-book-delay.giaobai")(app);
require("./routes/gb-set-book-priority.giaobai")(app);
require("./routes/gb-students-by-book.giaobai")(app);
require("./routes/gb-suggest-books.giaobai")(app);
require("./routes/gb-supabase-credentials.giaobai")(app);
require("./routes/gb-universallevels-sync.giaobai")(app);
require("./routes/gb-unpause-book.giaobai")(app);
require("./routes/gb-update-assigned-type.giaobai")(app);
require("./routes/gb-update-book.giaobai")(app);
require("./routes/gb-update-lesson.giaobai")(app);

// --- Player App Routes (migrated from Netlify) ---
require("./routes/player-supabase-credentials.player")(app);
require("./routes/player-presigned-url.player")(app);
require("./routes/player-lookup.player")(app);
require("./routes/player-owner-check.player")(app);
require("./routes/player-note-load.player")(app);
require("./routes/player-note-save.player")(app);
require("./routes/player-save-quiz-url.player")(app);

// --- Writing App Routes (migrated from Netlify) ---
require("./routes/wrt-supabase-credentials.writing")(app);
require("./routes/wrt-save-writing.writing")(app);
require("./routes/wrt-get-writing.writing")(app);
require("./routes/wrt-get-user-writings.writing")(app);
require("./routes/wrt-update-writing.writing")(app);
require("./routes/wrt-delete-writing.writing")(app);
require("./routes/wrt-get-submission.writing")(app);
require("./routes/wrt-get-all-submissions.writing")(app);
require("./routes/wrt-delete-submission.writing")(app);
require("./routes/wrt-save-complaint.writing")(app);
require("./routes/wrt-save-homework-content.writing")(app);
require("./routes/wrt-update-homework-status.writing")(app);
require("./routes/wrt-update-submission-zalo.writing")(app);
require("./routes/wrt-get-prompt.writing")(app);
require("./routes/wrt-save-prompt.writing")(app);
require("./routes/wrt-start-grading.writing")(app);
require("./routes/wrt-grade-writing.writing")(app);
require("./routes/wrt-grade-writing-background.writing")(app);
require("./routes/wrt-get-grading-status.writing")(app);
require("./routes/wrt-get-grading-by-submission.writing")(app);
require("./routes/wrt-presign-wasabi.writing")(app);
require("./routes/wrt-send-zalo.writing")(app);

// --- Watch App Routes (migrated from Netlify) ---
require("./routes/watch-supabase-credentials.watch")(app);
require("./routes/watch-teachers-list.watch")(app);
require("./routes/watch-meetings-list.watch")(app);
require("./routes/watch-meetings-create.watch")(app);
require("./routes/watch-meetings-delete.watch")(app);
require("./routes/watch-optimized-check.watch")(app);
require("./routes/watch-optimized-allowlist-get.watch")(app);
require("./routes/watch-optimized-allowlist-update.watch")(app);

// --- Giolamviec App Routes (migrated from Netlify) ---
require("./routes/glv-supabase-credentials.giolamviec")(app);
require("./routes/glv-get-work-hours.giolamviec")(app);
require("./routes/glv-lock-card.giolamviec")(app);
require("./routes/glv-approve-shift.giolamviec")(app);
require("./routes/glv-grant-duration.giolamviec")(app);
require("./routes/glv-deny-request.giolamviec")(app);
require("./routes/glv-submit-request.giolamviec")(app);
require("./routes/glv-delete-request.giolamviec")(app);
require("./routes/glv-delete-shift.giolamviec")(app);
require("./routes/glv-add-comment.giolamviec")(app);
require("./routes/glv-delete-comment.giolamviec")(app);
require("./routes/glv-deduct-duration.giolamviec")(app);
require("./routes/glv-add-deduction.giolamviec")(app);
require("./routes/glv-delete-deduction.giolamviec")(app);
require("./routes/glv-update-deduction.giolamviec")(app);
require("./routes/glv-add-deduction-comment.giolamviec")(app);
require("./routes/glv-update-granted.giolamviec")(app);
require("./routes/glv-update-meeting-link.giolamviec")(app);
require("./routes/glv-add-card-comment.giolamviec")(app);
require("./routes/glv-delete-card-comment.giolamviec")(app);
require("./routes/glv-get-card-comments.giolamviec")(app);
require("./routes/glv-get-card-comments-batch.giolamviec")(app);
require("./routes/glv-get-calculated-time.giolamviec")(app);
require("./routes/glv-get-calculated-time-batch.giolamviec")(app);
require("./routes/glv-search-students.giolamviec")(app);

// --- Calling App Routes (migrated from Netlify) ---
require("./routes/calling-supabase-credentials.calling")(app);
require("./routes/calling-vbot-token.calling")(app);
require("./routes/calling-vbot-token-manager.calling")(app);
require("./routes/calling-vbot-priority-manager.calling")(app);
require("./routes/calling-vbot-webhook.calling")(app);
require("./routes/calling-get-phone.calling")(app);
require("./routes/calling-save-task.calling")(app);
require("./routes/calling-delete-task.calling")(app);
require("./routes/calling-edit-task.calling")(app);
require("./routes/calling-track-call.calling")(app);
require("./routes/calling-get-call-counts.calling")(app);
require("./routes/calling-check-call-limit.calling")(app);
require("./routes/calling-log-widget-call.calling")(app);
require("./routes/calling-get-tracking-data.calling")(app);
require("./routes/calling-get-filter-options.calling")(app);
require("./routes/calling-delete-tracking-record.calling")(app);
require("./routes/calling-get-presigned-url.calling")(app);
require("./routes/calling-grant-access.calling")(app);
require("./routes/calling-search-candidates.calling")(app);
require("./routes/calling-verify-security-key.calling")(app);
require("./routes/calling-health-check.calling")(app);
require("./routes/calling-send-push-notification.calling")(app);

// --- Offteachers App Routes ---
require("./routes/off-danhsachhv.offteachers")(app);
require("./routes/off-editstudent.offteachers")(app);
require("./routes/off-tam-nghi.offteachers")(app);
require("./routes/off-save-clt.offteachers")(app);

// (duplicate offteachers block removed)

// --- Knowledge App Routes (migrated from Netlify) ---
require("./routes/kb-supabase-credentials.knowledge")(app);
require("./routes/kb-auto-save.knowledge")(app);
require("./routes/kb-embed-insert.knowledge")(app);
require("./routes/kb-embed-update.knowledge")(app);
require("./routes/kb-vector-search.knowledge")(app);
require("./routes/kb-soft-delete.knowledge")(app);
require("./routes/kb-permanent-delete.knowledge")(app);
require("./routes/kb-presign-wasabi.knowledge")(app);
require("./routes/kb-save-quiz.knowledge")(app);
require("./routes/kb-update-department.knowledge")(app);
require("./routes/kb-update-knowledge-importance.knowledge")(app);
require("./routes/kb-get-your-speech.knowledge")(app);
require("./routes/kb-image-proxy.knowledge")(app);
require("./routes/kb-manage-quiz-settings.knowledge")(app);
require("./routes/kb-manage-quiz-bypass.knowledge")(app);
require("./routes/kb-save-version.knowledge")(app);
require("./routes/kb-get-versions.knowledge")(app);

// --- Session App Routes (migrated from Netlify) ---
require("./routes/ses-supabase-credentials.session")(app);
require("./routes/ses-get-sessions-data.session")(app);
require("./routes/ses-get-availability-data.session")(app);
require("./routes/ses-get-working-teachers.session")(app);
require("./routes/ses-save-override.session")(app);
require("./routes/ses-get-override-history.session")(app);
require("./routes/ses-save-substitute-assignment.session")(app);
require("./routes/ses-save-student-transfer.session")(app);
require("./routes/ses-save-makeup-assignment.session")(app);

// --- PGDump App Routes (migrated from Netlify) ---
require("./routes/pgd-supabase-credentials.pgdump")(app);
require("./routes/pgd-check-role.pgdump")(app);
require("./routes/pgd-list-tables.pgdump")(app);
require("./routes/pgd-trigger-backup.pgdump")(app);
require("./routes/pgd-backup-status.pgdump")(app);
require("./routes/pgd-list-backups.pgdump")(app);
require("./routes/pgd-restore-backup.pgdump")(app);
require("./routes/pgd-delete-backup.pgdump")(app);
require("./routes/pgd-list-students-teachers.pgdump")(app);
require("./routes/pgd-delete-student-teacher-file.pgdump")(app);
require("./routes/pgd-bulk-delete-student-teacher-files.pgdump")(app);
require("./routes/pgd-list-video-uploads.pgdump")(app);
require("./routes/pgd-delete-video-upload.pgdump")(app);
require("./routes/pgd-restore-history.pgdump")(app);
require("./routes/pgd-presign-backup-url.pgdump")(app);
// --- Social App Routes (migrated from Netlify) ---
require("./routes/social-supabase-credentials.social")(app);
require("./routes/social-complete-task.social")(app);
require("./routes/social-update-post-status.social")(app);
require("./routes/social-presign-wasabi.social")(app);
require("./routes/social-send-zalo.social")(app);
require("./routes/social-assign-duty-bulk.social")(app);
require("./routes/social-tasks.social")(app);
// --- Search App Routes (migrated from Netlify) ---
require("./routes/srch-supabase-credentials.search")(app);
require("./routes/srch-vector-search.search")(app);
require("./routes/srch-embed-insert.search")(app);
require("./routes/srch-embed-update.search")(app);
require("./routes/srch-get-your-speech.search")(app);
require("./routes/srch-permanent-delete.search")(app);
require("./routes/srch-presign-wasabi.search")(app);
require("./routes/srch-update-search-department.search")(app);
require("./routes/srch-save-version.search")(app);
require("./routes/srch-get-versions.search")(app);
require("./routes/srch-popular-items.search")(app);
require("./routes/srch-increment-view.search")(app);

// --- Workstimestatus App Routes (migrated from Netlify) ---
require("./routes/wts-supabase-credentials.workstimestatus")(app);
require("./routes/wts-get-worktime-data.workstimestatus")(app);
require("./routes/wts-get-unscheduled-teachers.workstimestatus")(app);
require("./routes/wts-get-slhvvagv-data.workstimestatus")(app);
require("./routes/wts-get-dept-mismatch.workstimestatus")(app);
// --- DanhSachHV App Routes (migrated from Netlify) ---
require("./routes/dshv-supabase-credentials.danhsachhv")(app);
require("./routes/dshv-caplop-options.danhsachhv")(app);
require("./routes/dshv-danhsachhv.danhsachhv")(app);
require("./routes/dshv-editstudent.danhsachhv")(app);
require("./routes/dshv-thongtinhv.danhsachhv")(app);
require("./routes/dshv-deletestudent.danhsachhv")(app);
require("./routes/dshv-tam-nghi.danhsachhv")(app);
require("./routes/dshv-cap-lop-list.danhsachhv")(app);
require("./routes/dshv-cap-lop-create.danhsachhv")(app);
require("./routes/dshv-cap-lop-delete.danhsachhv")(app);
require("./routes/dshv-cap-lop-group.danhsachhv")(app);
require("./routes/dshv-cap-get-role.danhsachhv")(app);
require("./routes/dshv-get-student-teachers.danhsachhv")(app);
require("./routes/dshv-list-student-books.danhsachhv")(app);
require("./routes/dshv-unassign-book.danhsachhv")(app);
// --- Quota App Routes ---
require("./routes/quota-supabase-credentials.quota")(app);
require("./routes/quota-get-student-sessions.quota")(app);
// --- Send App Routes (migrated from Netlify) ---
require("./routes/eml-supabase-credentials.send")(app);
require("./routes/eml-get-emails.send")(app);
require("./routes/eml-send-emails.send")(app);
require("./routes/eml-validate-emails.send")(app);
require("./routes/eml-unsubscribe.send")(app);
require("./routes/eml-track-email-open.send")(app);
require("./routes/eml-handle-ses-bounce.send")(app);
// --- Forms App Routes (migrated from Netlify) ---
require("./routes/frm-supabase-credentials.forms")(app);
require("./routes/frm-save-template.forms")(app);
require("./routes/frm-update-template.forms")(app);
require("./routes/frm-delete-template.forms")(app);
require("./routes/frm-get-templates.forms")(app);
require("./routes/frm-get-submissions.forms")(app);
require("./routes/frm-delete-submission.forms")(app);
require("./routes/frm-presign-wasabi.forms")(app);

// --- Assistant Routes ---

require("./routes/ast-supabase-credentials.assistant")(app);

require("./routes/ast-ocr-vision.assistant")(app);

require("./routes/ast-chat.assistant")(app);

// --- Register Routes ---
require("./routes/reg-signup.register")(app);

// --- AssignDepartment Routes ---
require("./routes/dept-credentials.assigndepartment")(app);
require("./routes/dept-get-dashboard-data.assigndepartment")(app);
require("./routes/dept-assign-department.assigndepartment")(app);
require("./routes/dept-remove-department.assigndepartment")(app);

// --- Zalo OA Collector Routes ---
require("./routes/zalo-webhook.tszalo")(app);

// --- DanhGiaGV Routes ---
require("./routes/dg-credentials.danhgiagv")(app);
require("./routes/dg-get-latest-assessments.danhgiagv")(app);
require("./routes/dg-get-assessment-results.danhgiagv")(app);
require("./routes/dg-save-assessment-result.danhgiagv")(app);
require("./routes/dg-get-work-records.danhgiagv")(app);
require("./routes/dg-get-assessment-history.danhgiagv")(app);
require("./routes/dg-get-tieu-chi-by-type.danhgiagv")(app);
require("./routes/dg-get-content-list.danhgiagv")(app);
require("./routes/dg-save-content.danhgiagv")(app);
require("./routes/dg-edit-content.danhgiagv")(app);
require("./routes/dg-delete-content.danhgiagv")(app);
require("./routes/dg-get-tieu-chi.danhgiagv")(app);
require("./routes/dg-save-tieu-chi.danhgiagv")(app);
require("./routes/dg-edit-tieu-chi.danhgiagv")(app);
require("./routes/dg-delete-tieu-chi.danhgiagv")(app);

// --- Translate Routes ---
require("./routes/trl-supabase-credentials.translate")(app);
require("./routes/trl-translate.translate")(app);
require("./routes/trl-tts.translate")(app);
require("./routes/trl-vision-ocr.translate")(app);
require("./routes/trl-deepgram-transcribe.translate")(app);

// --- TimedCheck Routes ---
require("./routes/tck-supabase-credentials.timedcheck")(app);
require("./routes/tck-get-user-role.timedcheck")(app);
require("./routes/tck-save-test.timedcheck")(app);
require("./routes/tck-get-user-tests.timedcheck")(app);
require("./routes/tck-get-test.timedcheck")(app);
require("./routes/tck-delete-test.timedcheck")(app);
require("./routes/tck-update-test-time.timedcheck")(app);

// --- Homepage Routes ---
require("./routes/hp-supabase-credentials.homepage")(app);

// --- Speaking Routes ---

require("./routes/spk-supabase-credentials.speaking")(app);

require("./routes/spk-get-speaking.speaking")(app);

require("./routes/spk-get-user-speakings.speaking")(app);

require("./routes/spk-save-speaking.speaking")(app);

require("./routes/spk-update-speaking.speaking")(app);

require("./routes/spk-delete-speaking.speaking")(app);

require("./routes/spk-get-submission.speaking")(app);

require("./routes/spk-get-all-submissions.speaking")(app);

require("./routes/spk-delete-submission.speaking")(app);

require("./routes/spk-start-grading.speaking")(app);

require("./routes/spk-get-grading-status.speaking")(app);

require("./routes/spk-get-grading-by-submission.speaking")(app);

require("./routes/spk-grade-speaking-background.speaking")(app);

require("./routes/spk-grade-writing.speaking")(app);

require("./routes/spk-grade-transcript.speaking")(app);

require("./routes/spk-grade-transcript-background.speaking")(app);

require("./routes/spk-get-transcript-status.speaking")(app);

require("./routes/spk-get-transcription-status.speaking")(app);

require("./routes/spk-start-transcription.speaking")(app);

require("./routes/spk-transcription-background.speaking")(app);

require("./routes/spk-get-your-speech.speaking")(app);

require("./routes/spk-presign-wasabi.speaking")(app);

require("./routes/spk-start-multipart-upload.speaking")(app);

require("./routes/spk-get-part-url.speaking")(app);

require("./routes/spk-complete-multipart-upload.speaking")(app);

require("./routes/spk-list-parts.speaking")(app);

require("./routes/spk-abort-multipart-upload.speaking")(app);

require("./routes/spk-update-submission-zalo.speaking")(app);
require("./routes/spk-get-prompt.speaking")(app);
require("./routes/spk-save-prompt.speaking")(app);
require("./routes/spk-save-complaint.speaking")(app);
require("./routes/spk-save-homework-content.speaking")(app);
require("./routes/spk-update-homework-status.speaking")(app);
require("./routes/spk-send-zalo.speaking")(app);

// --- Speech Routes ---

require("./routes/spc-supabase-credentials.speech")(app);

require("./routes/spc-get-speech-content.speech")(app);

require("./routes/spc-get-your-speech.speech")(app);

require("./routes/spc-presign-wasabi.speech")(app);

require("./routes/spc-processing-correctness.speech")(app);

require("./routes/spc-save-speech-content.speech")(app);

require("./routes/spc-save-speech-submission.speech")(app);

// --- ReadText Routes ---

require("./routes/rt-supabase-credentials.readtext")(app);

require("./routes/rt-ping.readtext")(app);

require("./routes/rt-job-status.readtext")(app);

require("./routes/rt-recent-tts.readtext")(app);

require("./routes/rt-recent-tts-list.readtext")(app);

require("./routes/rt-speak.readtext")(app);

require("./routes/rt-speak-background.readtext")(app);

require("./routes/rt-voices.readtext")(app);

// --- Task Routes ---

require("./routes/tsk-supabase-credentials.task")(app);

require("./routes/tsk-departments.task")(app);

require("./routes/tsk-teachers.task")(app);

require("./routes/tsk-task-delete.task")(app);

require("./routes/tsk-task-update.task")(app);

require("./routes/tsk-update-teacher-max-sessions.task")(app);

require("./routes/tsk-work-tasks-calendar.task")(app);

require("./routes/tsk-work-tasks-individual.task")(app);

require("./routes/tsk-work-tasks-tags.task")(app);

require("./routes/tsk-work-tasks-tags-delete.task")(app);

require("./routes/tsk-work-tasks-tags-list.task")(app);

require("./routes/tsk-work-tasks-teacher-assignments.task")(app);

// --- StudentVideo Routes ---

require("./routes/sv-supabase-credentials.studentvideo")(app);

require("./routes/sv-get-approved-videos.studentvideo")(app);

require("./routes/sv-get-marking-criteria.studentvideo")(app);

require("./routes/sv-get-topic.studentvideo")(app);

require("./routes/sv-get-tracking-students.studentvideo")(app);

require("./routes/sv-get-videos.studentvideo")(app);

require("./routes/sv-presign-wasabi.studentvideo")(app);

require("./routes/sv-save-marking-result.studentvideo")(app);

require("./routes/sv-send-zalo.studentvideo")(app);

require("./routes/sv-submit-video.studentvideo")(app);

// --- VideoMakingTask Routes ---

require("./routes/vmt-supabase-credentials.videomakingtask")(app);

require("./routes/vmt-create-topic.videomakingtask")(app);

require("./routes/vmt-delete-task.videomakingtask")(app);

require("./routes/vmt-get-criteria.videomakingtask")(app);

require("./routes/vmt-get-tasks.videomakingtask")(app);

require("./routes/vmt-presign-wasabi.videomakingtask")(app);

require("./routes/vmt-save-criteria.videomakingtask")(app);

require("./routes/vmt-update-task.videomakingtask")(app);

// --- TrainingManagement Routes ---

require("./routes/tm-supabase-credentials.trainingmanagement")(app);

require("./routes/tm-get-departments.trainingmanagement")(app);

require("./routes/tm-get-trainees.trainingmanagement")(app);

require("./routes/tm-search-users.trainingmanagement")(app);

require("./routes/tm-save-trainee.trainingmanagement")(app);

require("./routes/tm-update-trainee.trainingmanagement")(app);

require("./routes/tm-delete-trainee.trainingmanagement")(app);

require("./routes/tm-save-training-session.trainingmanagement")(app);

require("./routes/tm-save-training-comment.trainingmanagement")(app);

require("./routes/tm-delete-training-comment.trainingmanagement")(app);

require("./routes/tm-assign-handler.trainingmanagement")(app);

// --- Feedback Routes ---

require("./routes/fb-supabase-credentials.feedback")(app);

require("./routes/fb-check-role.feedback")(app);

require("./routes/fb-save-question.feedback")(app);

require("./routes/fb-delete-question.feedback")(app);

require("./routes/fb-load-responses.feedback")(app);

require("./routes/fb-presign-teacher-image.feedback")(app);

require("./routes/fb-save-feedback-response.feedback")(app);

require("./routes/fb-students-learning-today.feedback")(app);

require("./routes/fb-teacher-rating.feedback")(app);

require("./routes/fb-update-question-order.feedback")(app);

// --- TeachersAndStudents Routes ---

require("./routes/tas-supabase-credentials.teachersandstudents")(app);

require("./routes/tas-teachers-list.teachersandstudents")(app);

// --- LevelAssignment Routes ---

require("./routes/la-supabase-credentials.levelassignment")(app);

require("./routes/la-dashboard-data.levelassignment")(app);

require("./routes/la-manage-assignment.levelassignment")(app);

require("./routes/la-update-department.levelassignment")(app);

// --- DemoManagement Routes ---
require("./routes/dm-supabase-credentials.demomanagement")(app);
require("./routes/dm-get-students.demomanagement")(app);
require("./routes/dm-get-classes.demomanagement")(app);
require("./routes/dm-save-student.demomanagement")(app);
require("./routes/dm-update-student.demomanagement")(app);
require("./routes/dm-delete-student.demomanagement")(app);
require("./routes/dm-delete-comment.demomanagement")(app);
require("./routes/dm-save-comment.demomanagement")(app);
require("./routes/dm-search-users.demomanagement")(app);
require("./routes/dm-assign-student.demomanagement")(app);

// --- ZaloTracker Routes ---
require("./routes/zt-supabase-credentials.zalotracker")(app);
require("./routes/zt-search-users.zalotracker")(app);
require("./routes/zt-add-student-contact.zalotracker")(app);
require("./routes/zt-delete-student-contact.zalotracker")(app);
require("./routes/zt-update-student-contact.zalotracker")(app);
require("./routes/zt-whoami-role.zalotracker")(app);
require("./routes/zt-zaloids.zalotracker")(app);

// --- UserRole Routes ---
require("./routes/ur-verify-security-key.userrole")(app);
require("./routes/ur-delete-user.userrole")(app);
require("./routes/ur-update-name.userrole")(app);
require("./routes/ur-update-role.userrole")(app);

// --- StudentCodes Routes ---
require("./routes/sc-supabase-credentials.studentcodes")(app);
require("./routes/sc-verify-security-key.studentcodes")(app);
require("./routes/sc-search-emails.studentcodes")(app);
require("./routes/sc-get-code.studentcodes")(app);
require("./routes/sc-save-codes.studentcodes")(app);
require("./routes/sc-presign-wasabi.studentcodes")(app);
require("./routes/sc-get-logs.studentcodes")(app);
require("./routes/sc-get-low-stock.studentcodes")(app);
require("./routes/sc-get-missing-students.studentcodes")(app);

// --- SecurityKey Routes ---
require("./routes/sk-supabase-credentials.securitykey")(app);
require("./routes/sk-admin-api.securitykey")(app);
require("./routes/sk-auto-key-generator.securitykey")(app);

// --- Monitor Routes ---
require("./routes/mon-status.monitor")(app);
require("./routes/mon-auth.monitor")(app);
require("./routes/mon-banned.monitor")(app);
require("./routes/mon-cron.monitor")(app);
require("./routes/mon-backups.monitor")(app);
require("./routes/mon-cache.monitor")(app);

// --- Supabase Proxy ---
// REMOVED Phase7: require("./routes/sb-proxy.system")(app);
require("./routes/mon-latency.monitor")(app);
require("./routes/mon-zalo-alert.monitor")(app);
app.listen(PORT, () => {
  console.log('API server running on port ' + PORT);
});

// --- Alert App Routes ---
require("./routes/alert-supabase-credentials.alert")(app);
require("./routes/alert-get-ttkb-alerts.alert")(app);
require("./routes/alert-get-missing-submissions.alert")(app);
require("./routes/alert-get-ttkb-content.alert")(app);
require("./routes/alert-get-submission-content.alert")(app);
require("./routes/alert-check-ttkb.alert")(app);
// --- TeacherCodes App Routes ---
require("./routes/tc-get-code.teachercodes")(app);
require("./routes/tc-upload-image.teachercodes")(app);

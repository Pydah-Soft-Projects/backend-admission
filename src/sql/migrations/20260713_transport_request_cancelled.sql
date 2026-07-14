-- Transport request cancellation support (run once on student_database).
ALTER TABLE transport_requests
  MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'cancelled') DEFAULT 'pending';

ALTER TABLE transport_requests
  ADD COLUMN cancellation_reason VARCHAR(500) NULL AFTER status;

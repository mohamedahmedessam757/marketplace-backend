-- Create the user_status ENUM type if it does not exist
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'BLOCKED');
  END IF;
END $$;

-- First, drop the current default value so it doesn't conflict during the type cast
ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;

-- Now safely alter the column to use the new ENUM type
ALTER TABLE "users" 
ALTER COLUMN "status" TYPE "user_status" USING "status"::text::"user_status";

-- Finally, set the correct default value using the new ENUM
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"user_status";

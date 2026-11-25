-- Smoke_UW _Fix.sql - fixes Issue Quote error 90021 "Cannot be authorised – Underwriter is not member of an Authority group".
-- The suite creates "Smoke,Underwriter" only as a party; this gives that party a Security user and an authority-team membership.
-- Run on preQC (Underwriting_AXAPreQC) on 2026-11-24. PartyId, template user and TeamId are preQC values: look them up for any other
-- environment, and run with @DryRun = 1 first (rolls back) to check the verify output.

SET XACT_ABORT ON;
BEGIN TRAN;

DECLARE @DryRun         BIT             = 0;                                    -- 1 = rollback at the end, 0 = commit
DECLARE @PartyId        INT             = 866025;                               -- Smoke, Underwriter
DECLARE @TemplateUserId INT             = 4481;                                 -- sapiens\shenki.singhai
DECLARE @TeamId         INT             = 88;                                   -- Level 1 (use 88 for Level 7)
DECLARE @LoginId        VARCHAR(200)    = 'sapiens\smoke.underwriter';
DECLARE @UserName       VARCHAR(200)    = 'Smoke Underwriter';
DECLARE @By             NVARCHAR(200)   = N'sys';
DECLARE @Now            DATETIMEOFFSET(7) = SYSDATETIMEOFFSET();
DECLARE @NewUserId      INT;

IF NOT EXISTS (SELECT 1 FROM Security.Users WHERE UserId = @TemplateUserId)
    THROW 50001, 'Template user not found', 1;
IF EXISTS (SELECT 1 FROM Security.Users WHERE PartyId = @PartyId)
    THROW 50002, 'A user already exists for this party', 1;
IF EXISTS (SELECT 1 FROM Security.Users WHERE LoginId = @LoginId)
    THROW 50003, 'LoginId already in use', 1;

-- 1. user (cloned from template, no password: domain login)
INSERT INTO Security.Users
    (LoginId, OrganisationMapId, UserName, [Password], [Status], CreateDate, SuperVisor, UserType,
     DomainName, LockCounter, LockStatus, TempPassword, DefaultTeamId, LastModifiedBy, LastModifiedDate,
     PasswordExpireDays, PartyId, PasswordNeverExpireIndicator)
SELECT @LoginId, OrganisationMapId, @UserName, NULL, 1, @Now, SuperVisor, UserType,
       DomainName, 0, 0, 0, @TeamId, @By, @Now,
       PasswordExpireDays, @PartyId, PasswordNeverExpireIndicator
FROM Security.Users WHERE UserId = @TemplateUserId;

SET @NewUserId = SCOPE_IDENTITY();

-- 2. Licence Authority team membership (the actual fix for 90021)
INSERT INTO Security.UserTeamMapping (UserId, TeamId, IsAdmin, LastModifiedBy, LastModifiedDate)
VALUES (@NewUserId, @TeamId, 0, @By, @Now);

-- 3. organisation mapping, copied from template
INSERT INTO Security.UserOrganisationMapping (UserId, OrganisationMapId, LastModifiedBy, LastModifiedDate)
SELECT @NewUserId, OrganisationMapId, @By, @Now
FROM Security.UserOrganisationMapping WHERE UserId = @TemplateUserId;

-- 4. role mapping, copied from template
INSERT INTO Security.UserRoleMap (UserId, RoleMasterId, LastModifiedBy, LastModifiedDate, IsDefaultRole, UserOrganisationMappingId)
SELECT @NewUserId, urm.RoleMasterId, @By, @Now, urm.IsDefaultRole, uom_new.UserOrganisationMappingId
FROM Security.UserRoleMap urm
LEFT JOIN Security.UserOrganisationMapping uom_old ON uom_old.UserOrganisationMappingId = urm.UserOrganisationMappingId
LEFT JOIN Security.UserOrganisationMapping uom_new ON uom_new.UserId = @NewUserId
                                                  AND uom_new.OrganisationMapId = uom_old.OrganisationMapId
WHERE urm.UserId = @TemplateUserId;

-- verify: this is exactly what GetTeamIdBasedOnUserId will now return for the underwriter on quote 123659
SELECT u.UserId, u.LoginId, u.PartyId, t.TeamId, t.TeamName, tt.TeamTypeDescription
FROM Security.Users u
JOIN Security.UserTeamMapping utm ON utm.UserId = u.UserId
JOIN Security.Team t              ON t.TeamId = utm.TeamId
JOIN MasterData.TeamType tt       ON tt.TeamTypeId = t.TeamType
WHERE u.UserId = @NewUserId;

-- what was copied
SELECT 'OrgMap' AS Kind, COUNT(*) AS Cnt FROM Security.UserOrganisationMapping WHERE UserId = @NewUserId
UNION ALL SELECT 'RoleMap', COUNT(*) FROM Security.UserRoleMap WHERE UserId = @NewUserId;

IF @DryRun = 1 ROLLBACK TRAN ELSE COMMIT TRAN;

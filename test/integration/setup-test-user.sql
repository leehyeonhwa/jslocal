-- 통합 테스트용 Tibero 계정 생성 (sys 또는 DBA 권한 계정으로 실행)
--   tbsql sys/<비밀번호>@<SID> @test/integration/setup-test-user.sql
--
-- 테스트는 TB_IT_<pid>_* 테이블을 만들었다가 지우기만 한다.
-- 운영 스키마와 섞이지 않도록 전용 계정을 쓰는 것을 권장한다.

CREATE USER jslocal_test IDENTIFIED BY jslocal_test
  DEFAULT TABLESPACE USR;

GRANT CREATE SESSION, CREATE TABLE TO jslocal_test;
ALTER USER jslocal_test QUOTA 10M ON USR;

-- 확인용: DB 캐릭터셋
SELECT NAME, VALUE FROM V$NLS_PARAMETERS WHERE NAME LIKE '%CHARACTERSET%';

-- 정리할 때
-- DROP USER jslocal_test CASCADE;
